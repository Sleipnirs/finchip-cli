import { loadConfig, getPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { ADDRESSES, AGENT_REGISTRY_ABI, PERM } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtChain } from '../utils.js';

const PERM_MAP = {
  read: PERM.READ, acquire: PERM.ACQUIRE,
  launch: PERM.LAUNCH, trade: PERM.TRADE, full: PERM.FULL,
};

const WALLET_TYPE_MAP = { eoa: 1, aa: 2, multisig: 3 };

export async function cmdRegister(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);

  // Resolve key
  let keyRaw;
  if (options.key) {
    const k = options.key;
    if (k.startsWith('0x') && k.length === 66) keyRaw = k;
    else if (k.startsWith('fc_')) keyRaw = '0x' + k.slice(3).padEnd(64, '0');
    else { err(`Invalid key format`); process.exit(1); }
  } else if (cfg.keyRaw) {
    keyRaw = cfg.keyRaw;
  } else {
    err('No fc_key. Run: finchip init --key fc_xxxxx');
    process.exit(1);
  }

  // Resolve permissions bitmask
  const permStr = (options.perm || 'full').toLowerCase();
  const permissions = PERM_MAP[permStr] ?? parseInt(permStr);
  if (isNaN(permissions)) {
    err(`Invalid perm: ${permStr}. Use: read | acquire | launch | trade | full | 0x0F`);
    process.exit(1);
  }

  // Wallet type
  const wtStr      = (options.walletType || 'eoa').toLowerCase();
  const walletType = WALLET_TYPE_MAP[wtStr] ?? parseInt(wtStr);

  const regAddr = ADDRESSES.agentRegistry[chainId];
  if (!regAddr) { err(`Unsupported chain: ${chainId}`); process.exit(1); }

  const privateKey = getPrivateKey(cfg);
  const { client, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chainId, cfg.rpc);

  const label       = options.label || cfg.label || `Agent ${fmtAddr(account.address)}`;
  const displayKey  = 'fc_' + keyRaw.slice(2, 34);

  hd('FinChip CLI — register');
  sep();
  inf(`key:        ${displayKey}`);
  inf(`wallet:     ${account.address}`);
  inf(`perm:       ${permStr} (0x${permissions.toString(16).padStart(2,'0')})`);
  inf(`walletType: ${wtStr}`);
  inf(`chain:      ${fmtChain(chainId)} (${chainId})`);
  inf(`label:      ${label}`);
  console.log('');
  inf('Sending transaction…');

  try {
    const hash = await client.writeContract({
      address: regAddr,
      abi:     AGENT_REGISTRY_ABI,
      functionName: 'register',
      args: [keyRaw, account.address, permissions, walletType, label],
    });
    ok(`tx submitted: ${hash}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`Registered on-chain · block ${receipt.blockNumber}`);
      inf(`AgentRegistry: ${regAddr}`);
      inf(`Run: finchip verify  to confirm`);
    } else {
      err('Transaction reverted');
      process.exit(1);
    }
  } catch (e) {
    err(`Registration failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    process.exit(1);
  }
  console.log('');
}
