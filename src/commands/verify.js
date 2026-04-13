import { loadConfig } from '../config.js';
import { getPublicClient } from '../client.js';
import { ADDRESSES, AGENT_REGISTRY_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtPerms, fmtChain } from '../utils.js';

export async function cmdVerify(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);
  const keyRaw  = options.key
    ? normaliseKey(options.key)
    : cfg.keyRaw;

  if (!keyRaw) {
    err('No fc_key found. Run: finchip init --key fc_xxxxx');
    process.exit(1);
  }

  const displayKey = 'fc_' + keyRaw.slice(2, 34);
  const regAddr    = ADDRESSES.agentRegistry[chainId];
  if (!regAddr) {
    err(`Unsupported chain: ${chainId}`);
    process.exit(1);
  }

  hd(`FinChip CLI — verify`);
  sep();
  inf(`key:   ${displayKey}`);
  inf(`chain: ${fmtChain(chainId)} (${chainId})`);
  inf(`registry: ${regAddr}`);
  console.log('');

  try {
    const client = getPublicClient(chainId, cfg.rpc);
    const agent  = await client.readContract({
      address: regAddr,
      abi:     AGENT_REGISTRY_ABI,
      functionName: 'verify',
      args: [keyRaw],
    });

    if (!agent.active) {
      err(`fc_key exists but is inactive (revoked)`);
      process.exit(1);
    }

    ok(`fc_key is ACTIVE on ${fmtChain(chainId)}`);
    inf(`wallet:      ${agent.wallet}`);
    inf(`permissions: ${fmtPerms(agent.permissions)} (0x${agent.permissions.toString(16).padStart(2,'0')})`);
    inf(`walletType:  ${['','EOA','AA','Multisig'][agent.walletType] || agent.walletType}`);
    inf(`registered:  ${new Date(Number(agent.registeredAt) * 1000).toISOString()}`);
    inf(`label:       ${agent.label || '—'}`);

    // Also show protocol addresses
    console.log('');
    inf('Protocol addresses:');
    const proto = await client.readContract({
      address: regAddr,
      abi:     AGENT_REGISTRY_ABI,
      functionName: 'getProtocol',
    });
    inf(`  chipRegistry: ${proto.chipRegistry}`);
    inf(`  factory:      ${proto.factory}`);
    inf(`  market:       ${proto.market}`);
    inf(`  feeRouter:    ${proto.feeRouter}`);
    console.log('');

  } catch (e) {
    err(`Key not registered on-chain: ${e.message?.split('\n')[0] || e}`);
    inf(`Run: finchip register --key ${displayKey}`);
    process.exit(1);
  }
}

function normaliseKey(key) {
  if (key.startsWith('0x') && key.length === 66) return key;
  if (key.startsWith('fc_') && key.length >= 35) return '0x' + key.slice(3).padEnd(64, '0');
  throw new Error(`Invalid key format: ${key}`);
}
