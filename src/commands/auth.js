import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, resolveConfiguredPrivateKey } from '../config.js';
import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { emitFailure, emitResult, fmtAddr, hd, inf, ok, sep } from '../utils.js';

function resolvePrivateKey() {
  const cfg = loadConfig();
  const privateKey = resolveConfiguredPrivateKey(cfg);
  if (!privateKey) {
    throw new FinchipAuthError(
      'AUTH_SIGNATURE_FAILED',
      'No valid private key found. Set FINCHIP_PRIVATE_KEY or configure privateKey.',
      3
    );
  }
  return { privateKey, chainId: Number(cfg.chain) || 56 };
}

function accountSummary(session) {
  return {
    userId: session.identity?.userId ?? session.account?.userId ?? null,
    username: session.identity?.username ?? null,
    walletAddr: session.wallet?.walletAddr ?? session.identity?.walletAddr ?? null,
    connections: {
      wallet: Boolean(session.connections?.wallet),
      github: Boolean(session.connections?.github),
    },
  };
}

function outputFailure(options, error) {
  const normalized = error instanceof FinchipAuthError
    ? error
    : new FinchipAuthError('AUTH_NETWORK_ERROR', error instanceof Error ? error.message : 'Authentication failed.');
  emitFailure(options, normalized, { fields: { authenticated: false } });
}

export async function cmdLogin(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (client.hasPersistedCredentials()) {
      const current = await client.getSession();
      if (current.authenticated) {
        throw new FinchipAuthError('AUTH_ALREADY_ACTIVE', 'A FinChip session is already active. Run `finchip logout` first.', 3);
      }
      client.clearCredentials();
    }

    const { privateKey, chainId } = resolvePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const walletAddr = account.address.toLowerCase();
    const challenge = await client.json('/api/auth/wallet/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_addr: walletAddr, preferred_chain_id: chainId }),
      persistCookies: false,
    });
    if (!challenge.response.ok || typeof challenge.payload?.message !== 'string') {
      throw new FinchipAuthError('AUTH_CHALLENGE_FAILED', challenge.payload?.error || 'Failed to create wallet login challenge.', challenge.response.status >= 500 ? 5 : 3);
    }

    let signature;
    try {
      signature = await account.signMessage({ message: challenge.payload.message });
    } catch {
      throw new FinchipAuthError('AUTH_SIGNATURE_FAILED', 'Failed to sign the FinChip wallet challenge.', 3);
    }

    const login = await client.json('/api/auth/wallet/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_addr: walletAddr,
        message: challenge.payload.message,
        signature,
        signature_chain_id: chainId,
      }),
      persistCookies: false,
    });
    if (!login.response.ok) {
      if (login.payload?.code === 'ACCOUNT_MERGE_REQUIRED') {
        throw new FinchipAuthError('AUTH_ACCOUNT_MERGE_REQUIRED', login.payload.error || 'Account merge confirmation is required.', 3);
      }
      throw new FinchipAuthError('AUTH_SESSION_INVALID', login.payload?.error || 'FinChip wallet login failed.', login.response.status >= 500 ? 5 : 3);
    }

    const session = await client.getSession();
    const sessionWallet = session.wallet?.walletAddr?.toLowerCase();
    if (!session.authenticated) {
      client.clearCredentials();
      throw new FinchipAuthError('AUTH_SESSION_INVALID', 'FinChip did not create an authenticated account session.', 3);
    }
    if (sessionWallet !== walletAddr) {
      client.clearCredentials();
      throw new FinchipAuthError('AUTH_WALLET_MISMATCH', 'Authenticated wallet does not match the signing wallet.', 3);
    }
    client.persistCredentials();

    const result = { ok: true, code: 'AUTHENTICATED', authenticated: true, origin: client.origin, account: accountSummary(session) };
    emitResult(options, result, () => {
      hd('FinChip CLI — login');
      sep();
      ok('Authenticated with FinChip');
      inf(`origin:   ${client.origin}`);
      inf(`username: ${result.account.username || '(not set)'}`);
      inf(`userId:   ${result.account.userId}`);
      inf(`wallet:   ${fmtAddr(result.account.walletAddr)}`);
    });
  } catch (error) {
    outputFailure(options, error);
  }
}

export async function cmdStatus(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (!client.hasPersistedCredentials()) {
      const result = { ok: false, code: 'AUTH_REQUIRED', authenticated: false, origin: client.origin, account: null };
      emitResult(options, result, () => inf(`Not authenticated with ${client.origin}. Run \`finchip login\`.`));
      process.exitCode = 2;
      return;
    }
    const session = await client.getSession();
    if (!session.authenticated) {
      client.clearCredentials();
      const result = { ok: false, code: 'AUTH_REQUIRED', authenticated: false, origin: client.origin, account: null };
      emitResult(options, result, () => inf('FinChip session is expired or revoked. Run `finchip login`.'));
      process.exitCode = 2;
      return;
    }
    const result = { ok: true, code: 'AUTHENTICATED', authenticated: true, origin: client.origin, account: accountSummary(session) };
    emitResult(options, result, () => {
      hd('FinChip CLI — status');
      sep();
      ok('Authenticated');
      inf(`origin:   ${client.origin}`);
      inf(`username: ${result.account.username || '(not set)'}`);
      inf(`userId:   ${result.account.userId}`);
      inf(`wallet:   ${fmtAddr(result.account.walletAddr)}`);
      inf(`connections: wallet=${result.account.connections.wallet ? 'yes' : 'no'}, github=${result.account.connections.github ? 'yes' : 'no'}`);
    });
  } catch (error) {
    outputFailure(options, error);
  }
}

export async function cmdLogout(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (!client.hasPersistedCredentials()) {
      const result = { ok: true, code: 'LOGGED_OUT', authenticated: false, origin: client.origin };
      emitResult(options, result, () => ok('No active FinChip session.'));
      return;
    }
    const { response, payload } = await client.json('/api/auth/logout', {
      method: 'POST',
      persistCookies: false,
    });
    if (!response.ok) {
      throw new FinchipAuthError('AUTH_NETWORK_ERROR', payload?.error || `Logout failed with status ${response.status}.`, response.status >= 500 ? 5 : 3);
    }
    client.clearCredentials();
    const result = { ok: true, code: 'LOGGED_OUT', authenticated: false, origin: client.origin };
    emitResult(options, result, () => ok(`Logged out from ${client.origin}.`));
  } catch (error) {
    outputFailure(options, error);
  }
}
