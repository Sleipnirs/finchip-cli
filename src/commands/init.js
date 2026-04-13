import { loadConfig, saveConfig, getConfigPath } from '../config.js';
import { getPublicClient } from '../client.js';
import { ADDRESSES, AGENT_REGISTRY_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtPerms, fmtChain } from '../utils.js';

export async function cmdInit(options) {
  const { key, chain: chainStr } = options;
  const chainId = parseInt(chainStr || '56');

  if (!key) {
    err('--key is required. Get your fc_key at https://finchip.ai/a2aentry');
    process.exit(1);
  }

  // Normalise key: accept both "fc_xxxxx" (display) and "0x..." (bytes32)
  let keyRaw;
  if (key.startsWith('0x') && key.length === 66) {
    keyRaw = key;
  } else if (key.startsWith('fc_') && key.length === 35) {
    // display format: fc_ + 32 hex chars — pad to full bytes32
    keyRaw = '0x' + key.slice(3).padEnd(64, '0');
  } else {
    err(`Invalid key format. Expected fc_<32 hex chars> or 0x<64 hex chars>`);
    process.exit(1);
  }

  const displayKey = 'fc_' + keyRaw.slice(2, 34);

  hd('FinChip CLI — init');
  sep();
  inf(`key:   ${displayKey}`);
  inf(`chain: ${fmtChain(chainId)} (${chainId})`);

  // Try to verify key on-chain
  const registryAddr = ADDRESSES.agentRegistry[chainId];
  if (registryAddr) {
    try {
      const client = getPublicClient(chainId);
      const agent = await client.readContract({
        address: registryAddr,
        abi: AGENT_REGISTRY_ABI,
        functionName: 'verify',
        args: [keyRaw],
      });
      if (agent.active) {
        ok(`fc_key verified on-chain · wallet: ${fmtAddr(agent.wallet)}`);
        inf(`permissions: ${fmtPerms(agent.permissions)}`);
        inf(`label: ${agent.label || '—'}`);
      } else {
        inf(`fc_key not yet registered on-chain (run: finchip register --key ${displayKey})`);
      }
    } catch {
      inf('Could not verify on-chain (key not registered yet — that is OK)');
    }
  }

  // Save config
  const cfg = loadConfig();
  cfg.key     = displayKey;
  cfg.keyRaw  = keyRaw;
  cfg.chain   = chainId;
  saveConfig(cfg);

  sep();
  ok(`Config saved → ${getConfigPath()}`);
  console.log('');
  console.log('  Next steps:');
  inf('finchip verify              — confirm registration on-chain');
  inf('finchip market list         — browse available chips');
  inf('finchip acquire --slug <s>  — acquire a skill chip');
  inf('finchip launch ./skill/     — publish your own chip');
  console.log('');
}
