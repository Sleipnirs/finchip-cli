// FinChip CLI v0.3.0 — x402 client
// =================================
// Implements Coinbase's x402 Payment Required protocol v1.
// Reference: https://github.com/coinbase/x402
//
// Flow:
//   1. Client GETs a protected resource
//   2. Server returns 402 Payment Required with body:
//        { x402Version: 1, accepts: [{ scheme, network, payTo, asset, ... }] }
//      and headers:
//        WWW-Authenticate: x402 realm="...", scheme="exact", version="1"
//        X-Payment-Required: <base64 JSON accepts>
//   3. Client picks an accepts entry matching a chain it has funds on
//   4. Client signs EIP-3009 TransferWithAuthorization on the USDC contract
//   5. Client retries the original request with X-Payment header:
//        X-Payment: <base64 JSON payment payload>
//   6. Server verifies/settles, returns the paid response (with X-Payment-Response)
//
// Important: x402's "exact" scheme uses signed authorizations — the client
// does NOT broadcast a transaction itself. The server (or its facilitator)
// submits the signed auth to USDC.transferWithAuthorization() and pays the gas.
// This means the client only needs to sign, not to spend gas.

import { resolveChain, getUsdc } from './chains.js';
import { getPublicClient, getWalletClient } from './client.js';
import { ERC20_ABI } from './protocol.js';

// ── x402 spec constants ─────────────────────────────────────────────────────
const X402_VERSION = 1;

// Network name mapping: x402 uses string network names, viem uses chain IDs.
// Aligned with Coinbase x402 v1 canonical names.
const X402_NETWORK_TO_CHAIN_ID = {
  'base':         8453,
  'base-mainnet': 8453,
  'ethereum':     1,
  'eth':          1,
  'arbitrum':     42161,
  'arbitrum-one': 42161,
  'optimism':     10,
  'op':           10,
  'bnb':          56,
  'bsc':          56,
  'bsc-mainnet':  56,
};

const CHAIN_ID_TO_X402_NETWORK = {
  8453:  'base',
  1:     'ethereum',
  42161: 'arbitrum',
  10:    'optimism',
  56:    'bnb',
};

/**
 * Parse a 402 response into a structured challenge object.
 *
 * @param {Response} response   The fetch Response (status 402)
 * @returns {Promise<{x402Version, accepts, headers}>}
 */
export async function parseChallenge(response) {
  if (response.status !== 402) {
    throw new Error(`Expected status 402, got ${response.status}`);
  }
  const body = await response.json();
  if (body.x402Version !== X402_VERSION) {
    throw new Error(`Unsupported x402 version: ${body.x402Version}`);
  }
  return {
    x402Version: body.x402Version,
    accepts: body.accepts || [],
    error: body.error || null,
    headers: Object.fromEntries(response.headers.entries()),
    raw: body,
  };
}

/**
 * GET the URL and, if it returns 402, parse the challenge.
 * Returns { paid: false, response, challenge } if 402, { paid: true, response } otherwise.
 */
export async function probe(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 402) {
    const challenge = await parseChallenge(response);
    return { paid: false, response, challenge };
  }
  return { paid: true, response };
}

/**
 * Pick the best accepts entry for the wallet — preferring chains where the
 * wallet has both native gas balance and USDC balance.
 *
 * @returns The matching accepts entry, or null if no suitable chain found.
 */
export async function selectAccepts(accepts, walletAddress) {
  const candidates = accepts
    .filter(a => a.scheme === 'exact')
    .filter(a => X402_NETWORK_TO_CHAIN_ID[a.network])
    .map(a => ({ ...a, chainId: X402_NETWORK_TO_CHAIN_ID[a.network] }));

  if (candidates.length === 0) return null;

  // Check USDC balance on each candidate chain
  for (const c of candidates) {
    try {
      const client = getPublicClient(c.chainId);
      const usdcAddr = c.asset || getUsdc(c.chainId);
      if (!usdcAddr) continue;
      const balance = await client.readContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAddress],
      });
      const required = BigInt(c.maxAmountRequired);
      if (balance >= required) {
        return { ...c, chosenUsdc: usdcAddr, walletUsdcBalance: balance };
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Sign an EIP-3009 TransferWithAuthorization on the given USDC contract.
 * Returns the signed authorization payload — to be base64'd into X-Payment.
 *
 * USDC implements EIP-3009 with this typed-data structure:
 *   domain:    { name, version, chainId, verifyingContract }
 *   types: TransferWithAuthorization:
 *     [from, to, value, validAfter, validBefore, nonce]
 */
export async function signPayment({ chainId, walletClient, account, accept }) {
  const usdcAddr = accept.chosenUsdc || accept.asset || getUsdc(chainId);
  if (!usdcAddr) throw new Error(`No USDC contract for chain ${chainId}`);

  // Fetch USDC ERC-20 metadata for the EIP-712 domain
  const pub = getPublicClient(chainId);
  const [name, decimals] = await Promise.all([
    pub.readContract({ address: usdcAddr, abi: ERC20_ABI, functionName: 'name'     }).catch(() => 'USD Coin'),
    pub.readContract({ address: usdcAddr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 6),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const validAfter  = 0n;
  const validBefore = BigInt(now + (accept.maxTimeoutSeconds ?? 60));
  // EIP-3009 requires a unique random bytes32 nonce per authorization
  const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const domain = {
    name,
    version:           '2',           // USDC uses version "2" for EIP-3009 since 2021
    chainId,
    verifyingContract: usdcAddr,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' },
    ],
  };

  const message = {
    from:        account.address,
    to:          accept.payTo,
    value:       BigInt(accept.maxAmountRequired),
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  // Build the payment payload per Coinbase x402 v1 "exact" scheme
  const payload = {
    x402Version: X402_VERSION,
    scheme:      'exact',
    network:     CHAIN_ID_TO_X402_NETWORK[chainId] || accept.network,
    payload: {
      signature,
      authorization: {
        from:        account.address,
        to:          accept.payTo,
        value:       message.value.toString(),
        validAfter:  validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  // Base64-encoded payload as the X-Payment header value
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');

  return {
    payload,
    header: b64,
    domain,
    usdc: { address: usdcAddr, name, decimals },
  };
}

/**
 * Retry the original request with the X-Payment header attached.
 * Returns the final paid Response.
 */
export async function retryWithPayment(url, paymentHeader, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      'X-Payment': paymentHeader,
    },
  });
}

/**
 * End-to-end x402 flow.
 *
 *   1. probe(url)
 *   2. If 402:
 *      a. selectAccepts (find a chain we have USDC on)
 *      b. signPayment (EIP-3009 typed-data sign)
 *      c. retryWithPayment
 *   3. Return the final response
 *
 * Throws on insufficient balance, missing wallet, or settlement failure.
 */
export async function pay({ url, walletClient, account, dryRun = false }) {
  const r = await probe(url);
  if (r.paid) {
    return { paid: true, mode: 'no-payment-required', response: r.response };
  }

  const accept = await selectAccepts(r.challenge.accepts, account.address);
  if (!accept) {
    throw new Error(
      'No matching chain found with sufficient USDC balance.\n' +
      'Server accepts: ' + r.challenge.accepts.map(a => `${a.network} (need ${a.maxAmountRequired})`).join(', ')
    );
  }

  if (dryRun) {
    return {
      paid: false,
      mode: 'dry-run',
      accept,
      challenge: r.challenge,
    };
  }

  const sig = await signPayment({
    chainId: accept.chainId,
    walletClient,
    account,
    accept,
  });

  const paidResponse = await retryWithPayment(url, sig.header);

  return {
    paid: paidResponse.ok,
    mode: 'signed-and-retried',
    response: paidResponse,
    accept,
    payment: sig,
  };
}
