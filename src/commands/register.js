// finchip register — write fc_key to AgentRegistry on-chain
import { loadConfig, getPrivateKey, keyToBytes32, keyToDisplay } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { AGENT_REGISTRY, AGENT_REGISTRY_ABI, PERM, WALLET_TYPE } from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtChain, fmtTxLink } from '../utils.js';

const PERM_MAP = {
  read:    PERM.READ,
  acquire: PERM.ACQUIRE,
  launch:  PERM.LAUNCH,
  trade:   PERM.TRADE,
  full:    PERM.FULL,
};

const WALLET_TYPE_MAP = {
  eoa:      WALLET_TYPE.EOA,
  aa:       WALLET_TYPE.AA,
  multisig: WALLET_TYPE.MULTISIG,
};

export async function cmdRegister(options) {
  const cfg   = loadConfig();
  const chain = resolveChain(options.chain || cfg.chain);

  // Resolve key
  let keyRaw;
  try {
    keyRaw = options.key ? keyToBytes32(options.key) : cfg.keyRaw;
  } catch (e) { err(e.message); process.exit(1); }
  if (!keyRaw) { err('No fc_key. Run: finchip init --key fc_xxxxx'); process.exit(1); }

  // Permissions bitmask
  const permStr = (options.perm || 'full').toLowerCase();
  let permissions = PERM_MAP[permStr];
  if (permissions === undefined) {
    // Allow numeric/hex passthrough: --perm 0x06 or --perm 6
    const n = permStr.startsWith('0x') ? parseInt(permStr, 16) : parseInt(permStr);
    if (isNaN(n) || n < 1 || n > 0x0F) {
      err(`Invalid perm: ${permStr}. Use: read | acquire | launch | trade | full | 0x0F`);
      process.exit(1);
    }
    permissions = n;
  }

  // Wallet type
  const wtStr      = (options.walletType || 'eoa').toLowerCase();
  const walletType = WALLET_TYPE_MAP[wtStr] ?? parseInt(wtStr);
  if (![WALLET_TYPE.EOA, WALLET_TYPE.AA, WALLET_TYPE.MULTISIG].includes(walletType)) {
    err(`Invalid walletType: ${wtStr}. Use: eoa | aa | multisig`);
    process.exit(1);
  }

  const privateKey = getPrivateKey(cfg);
  const { client, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  const label      = options.label || cfg.label || `Agent ${fmtAddr(account.address)}`;
  const displayKey = keyToDisplay(keyRaw);
  const regAddr    = AGENT_REGISTRY[chain.id];

  hd('FinChip CLI — register');
  sep();
  inf(`key:        ${displayKey}`);
  inf(`wallet:     ${account.address}`);
  inf(`perm:       ${permStr} (0x${permissions.toString(16).padStart(2,'0')})`);
  inf(`walletType: ${wtStr}`);
  inf(`chain:      ${fmtChain(chain.id)} (${chain.id})`);
  inf(`registry:   ${regAddr}`);
  inf(`label:      ${label}`);
  console.log('');
  inf('Sending transaction…');

  try {
    const hash = await client.writeContract({
      address:      regAddr,
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'register',
      args:         [keyRaw, account.address, permissions, walletType, label],
    });
    ok(`tx submitted: ${hash}`);
    inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`Registered on-chain · block ${receipt.blockNumber}`);
      inf('Run: finchip verify  to confirm');
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
