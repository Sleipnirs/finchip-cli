// finchip pay <url> — consume an HTTP 402 (x402) payment challenge
//
// Probes the URL. If it returns 402 with an x402 challenge body, the CLI:
//   1. Picks the chain with sufficient USDC balance
//   2. Signs an EIP-3009 TransferWithAuthorization (no gas required)
//   3. Retries the request with the X-Payment header
//   4. Prints the paid response
//
// If --dry-run, the CLI does NOT sign or retry — it just prints what it would
// pay and where, so users can inspect challenges safely.

import { loadConfig, getPrivateKey } from '../config.js';
import { getWalletClient } from '../client.js';
import { probe, selectAccepts, signPayment, retryWithPayment, pay as x402Pay } from '../x402.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtChain, fmtUsdc, c } from '../utils.js';

export async function cmdPay(url, options) {
  if (!url || !url.startsWith('http')) {
    err('Usage: finchip pay <url>');
    process.exit(1);
  }
  const cfg     = loadConfig();
  const dryRun  = !!options.dryRun;

  hd(`FinChip CLI — x402 pay`);
  sep();
  inf(`url:     ${url}`);
  inf(`mode:    ${dryRun ? 'dry-run (will NOT sign or send payment)' : 'live (will sign + retry)'}`);
  console.log('');

  // 1. Probe URL
  inf('Probing URL…');
  const probeResult = await probe(url);

  if (probeResult.paid) {
    ok(`URL returned ${probeResult.response.status} — no payment required`);
    const txt = await probeResult.response.text();
    console.log('');
    console.log(`${c.gray}Response body:${c.reset}`);
    console.log(txt.slice(0, 2000));
    if (txt.length > 2000) inf(`… ${txt.length - 2000} more characters omitted`);
    return;
  }

  ok(`Received 402 challenge`);
  const challenge = probeResult.challenge;
  inf(`x402Version: ${challenge.x402Version}`);
  inf(`accepts:     ${challenge.accepts.length} payment option(s)`);
  console.log('');

  // Display each accept option
  console.log(`${c.bold}Available payment options:${c.reset}`);
  for (const a of challenge.accepts) {
    console.log(`  ${c.gray}─${c.reset} ${c.cyan}${a.network}${c.reset}`);
    console.log(`     scheme:    ${a.scheme}`);
    console.log(`     amount:    ${fmtUsdc(a.maxAmountRequired)}`);
    console.log(`     payTo:     ${a.payTo}`);
    console.log(`     asset:     ${a.asset}`);
    if (a.description) console.log(`     desc:      ${a.description}`);
  }
  console.log('');

  // 2. Need wallet to proceed (even for dry-run — to check USDC balance)
  let privateKey;
  try {
    privateKey = getPrivateKey(cfg);
  } catch {
    err('Need FINCHIP_PRIVATE_KEY to evaluate which chain has USDC balance.');
    process.exit(1);
  }

  // We need a wallet client; pick chain from first accepts entry for the client.
  // selectAccepts will then evaluate balance across all candidate chains.
  const firstNetwork = challenge.accepts[0]?.network;
  // Map x402 network names to chainIds for the wallet client
  const networkChainIdMap = {
    base: 8453, ethereum: 1, arbitrum: 42161, optimism: 10, bnb: 56, bsc: 56,
  };
  const seedChainId = networkChainIdMap[firstNetwork] || 56;
  const { client: walletClient, account } = getWalletClient(seedChainId, privateKey, cfg.rpc);

  // 3. Pick best chain
  inf('Checking USDC balance on candidate chains…');
  const chosen = await selectAccepts(challenge.accepts, account.address);
  if (!chosen) {
    err('No matching chain found with sufficient USDC balance.');
    inf(`Wallet: ${account.address}`);
    inf(`Top up USDC on one of: ${challenge.accepts.map(a => a.network).join(', ')}`);
    process.exit(1);
  }

  const chosenChain = resolveChain(chosen.chainId);
  ok(`Selected: ${chosenChain.name} · USDC balance ${fmtUsdc(chosen.walletUsdcBalance)}`);
  inf(`Will pay: ${fmtUsdc(chosen.maxAmountRequired)}`);
  inf(`To:       ${chosen.payTo}`);
  console.log('');

  if (dryRun) {
    inf(`${c.yellow}Dry-run mode — not signing or sending payment.${c.reset}`);
    inf(`Re-run without --dry-run to actually pay.`);
    return;
  }

  // 4. Sign + retry
  // We need a wallet client on the CHOSEN chain (might differ from seed)
  const { client: chosenWalletClient, account: chosenAccount } = getWalletClient(
    chosen.chainId, privateKey, cfg.rpc
  );

  inf('Signing EIP-3009 TransferWithAuthorization on USDC…');
  let signed;
  try {
    signed = await signPayment({
      chainId:      chosen.chainId,
      walletClient: chosenWalletClient,
      account:      chosenAccount,
      accept:       chosen,
    });
  } catch (e) {
    err(`Signing failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
  ok(`Payment signed (no gas needed — server submits the authorization)`);
  inf(`USDC:  ${signed.usdc.address}`);

  inf('Retrying request with X-Payment header…');
  const paidRes = await retryWithPayment(url, signed.header);
  if (!paidRes.ok) {
    err(`Server rejected payment: ${paidRes.status} ${paidRes.statusText}`);
    const errBody = await paidRes.text();
    console.log(errBody.slice(0, 1000));
    process.exit(1);
  }

  ok(`Payment accepted · ${paidRes.status} ${paidRes.statusText}`);
  const paymentResp = paidRes.headers.get('x-payment-response');
  if (paymentResp) inf(`X-Payment-Response: ${paymentResp.slice(0, 80)}…`);
  console.log('');
  console.log(`${c.gray}Paid response body:${c.reset}`);
  const body = await paidRes.text();
  console.log(body.slice(0, 4000));
  if (body.length > 4000) inf(`… ${body.length - 4000} more characters omitted`);
  console.log('');
}
