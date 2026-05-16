// finchip init — bootstrap CLI with fc_key, save config, verify on-chain
import { loadConfig, saveConfig, getConfigPath, keyToBytes32, keyToDisplay } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient } from '../client.js';
import { AGENT_REGISTRY, AGENT_REGISTRY_ABI } from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtPerms, fmtChain, c } from '../utils.js';

export async function cmdInit(options) {
  const { key } = options;
  if (!key) {
    err('--key is required. Get your fc_key at https://finchip.ai/a2aentry');
    process.exit(1);
  }

  let keyRaw;
  try {
    keyRaw = keyToBytes32(key);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
  const displayKey = keyToDisplay(keyRaw);

  const chain = resolveChain(options.chain);

  hd('FinChip CLI — init');
  sep();
  inf(`key:   ${displayKey}`);
  inf(`chain: ${fmtChain(chain.id)} (${chain.id})`);

  // Try to verify on-chain — informational only, doesn't block init
  try {
    const client = getPublicClient(chain.id);
    const agent = await client.readContract({
      address:      AGENT_REGISTRY[chain.id],
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'verify',
      args:         [keyRaw],
    });
    if (agent.active) {
      ok(`fc_key verified on-chain · wallet: ${fmtAddr(agent.wallet)}`);
      inf(`permissions: ${fmtPerms(agent.permissions)}`);
      inf(`label:       ${agent.label || '—'}`);
    }
  } catch {
    inf('fc_key not yet registered on-chain (run `finchip register --perm full` after setting your wallet)');
  }

  // Resolve protocol addresses (proves discovery works)
  try {
    const proto = await resolveProtocol(chain.id);
    inf(`protocol:    discovered via AgentRegistry.${proto.source}()`);
    if (proto.factoryPaused) {
      inf(`${c.yellow}⚠ Factory is currently paused on this chain${c.reset}`);
    }
  } catch (e) {
    inf(`protocol:    discovery failed (${e.shortMessage || e.message})`);
  }

  // Save config
  const cfg = loadConfig();
  cfg.key    = displayKey;
  cfg.keyRaw = keyRaw;
  cfg.chain  = chain.id;
  saveConfig(cfg);

  sep();
  ok(`Config saved → ${getConfigPath()}`);
  console.log('');
  console.log('  Next steps:');
  inf('export FINCHIP_PRIVATE_KEY=0x...   — set your agent wallet');
  inf('finchip register --perm full        — register fc_key on-chain');
  inf('finchip verify                       — confirm registration');
  inf('finchip doctor                       — full A2A + protocol health check');
  inf('finchip market list                  — browse available chips');
  console.log('');
}
