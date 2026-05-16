// finchip doctor — full A2A + protocol health check
//
// 3 layers of verification in one command:
//   Layer 1 — Hardcoded AgentRegistry addresses on all 5 chains
//   Layer 2 — finchip.ai/.well-known/* endpoints (the A2A network surface)
//   Layer 3 — On-chain protocol state via getProtocolExtended()
//
// Plus drift detection: does the agent-card.json declare the same addresses
// that AgentRegistry reports? If not, the website may be stale.

import { loadConfig } from '../config.js';
import { resolveAllChains, getRegistryVersion } from '../discovery.js';
import { pingAllEndpoints, fetchAgentCard, DEFAULT_BASE } from '../a2a-client.js';
import { AGENT_REGISTRY } from '../protocol.js';
import { listChains } from '../chains.js';
import { hd, sep, ok, err, inf, wrn, fmtChain, fmtBool, fmtAddr, c } from '../utils.js';

export async function cmdDoctor(options) {
  const cfg     = loadConfig();
  const verbose = !!options.verbose;

  hd('FinChip CLI — doctor');
  sep();
  inf(`A2A base: ${DEFAULT_BASE}`);
  inf(`config:   ${cfg.key || '(no fc_key — run finchip init)'}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 1 — Hardcoded AgentRegistry table
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${c.bold}Layer 1 · Hardcoded AgentRegistry addresses${c.reset}`);
  sep();
  for (const ch of listChains()) {
    const addr = AGENT_REGISTRY[ch.id];
    if (addr) ok(`${ch.name.padEnd(22)} (${String(ch.id).padStart(5)}): ${addr}`);
    else      err(`${ch.name.padEnd(22)} (${String(ch.id).padStart(5)}): MISSING`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 2 — A2A network endpoints
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${c.bold}Layer 2 · A2A network endpoints (finchip.ai/.well-known/*)${c.reset}`);
  sep();
  let pingResults;
  try {
    pingResults = await pingAllEndpoints();
  } catch (e) {
    err(`Endpoint scan failed: ${e.message}`);
    pingResults = [];
  }

  const byGroup = {};
  for (const r of pingResults) (byGroup[r.group] = byGroup[r.group] || []).push(r);

  let okCount = 0, failCount = 0;
  for (const [group, rs] of Object.entries(byGroup)) {
    console.log(`  ${c.gray}${group}${c.reset}`);
    for (const r of rs) {
      const status = r.ok ? `${c.green}${r.status}${c.reset}` : `${c.red}${r.status || 'ERR'}${c.reset}`;
      const mark   = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const label  = r.critical ? '' : `${c.gray} (legacy)${c.reset}`;
      console.log(`    ${mark} ${status.padEnd(20)} ${r.path}${label}`);
      if (r.ok) okCount++;
      else if (r.critical) failCount++;
    }
  }
  console.log('');
  if (failCount === 0) ok(`${okCount} endpoint(s) healthy · 0 critical failures`);
  else                 err(`${failCount} critical endpoint(s) failed`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // Layer 3 — On-chain protocol state
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${c.bold}Layer 3 · On-chain protocol state (getProtocolExtended)${c.reset}`);
  sep();
  const chainResults = await resolveAllChains();

  let pausedAny = false;
  for (const r of chainResults) {
    const ch = listChains().find(c => c.id === r.chainId);
    if (!r.ok) {
      err(`${ch.name.padEnd(22)} (${String(ch.id).padStart(5)}): ${r.error?.shortMessage || r.error?.message || 'unreachable'}`);
      continue;
    }
    const d = r.data;
    const ver = await getRegistryVersion(r.chainId).catch(() => null);
    const verTag = ver ? ` [${ver}]` : '';
    const pausedTag = d.factoryPaused ? ` ${c.yellow}⚠ factoryPaused${c.reset}` : '';
    if (d.factoryPaused) pausedAny = true;
    ok(`${ch.name.padEnd(22)} (${String(ch.id).padStart(5)})${verTag} · ${d.source}${pausedTag}`);
    if (verbose) {
      inf(`  chipRegistry:    ${d.chipRegistry}`);
      inf(`  factory:         ${d.factory}`);
      inf(`  market:          ${d.market}`);
      inf(`  feeRouter:       ${d.feeRouter}`);
      inf(`  erc1155Deployer: ${d.erc1155Deployer || '(none)'}`);
      inf(`  erc721Deployer:  ${d.erc721Deployer  || '(none)'}`);
    }
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // Drift check — does agent-card.json match on-chain addresses?
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${c.bold}Drift check · agent-card.json vs on-chain${c.reset}`);
  sep();
  try {
    const { body: card } = await fetchAgentCard();
    // agent-card.json declares registries in different shapes depending on version.
    // We try the most common locations.
    // Build a chainId → AgentRegistry-address map from the agent-card.
    // Schema (matches finchip.ai/.well-known/agent-card.json):
    //   on_chain_protocol.supported_chains[].{chain_id, agent_registry}
    // Falls back to alternative shapes for resilience.
    const cardRegistries = {};

    // Path 1 (canonical FinChip schema): on_chain_protocol.supported_chains[]
    const supportedChains =
      card?.on_chain_protocol?.supported_chains ||
      card?.onChainProtocol?.supportedChains    ||
      [];
    for (const entry of supportedChains) {
      const cid  = entry.chain_id     ?? entry.chainId;
      const addr = entry.agent_registry ?? entry.agentRegistry;
      if (cid && addr) cardRegistries[cid] = addr;
    }

    // Path 2 (legacy / fallback): on_chain_protocol.registries or contracts
    const legacyMap =
      card?.on_chain_protocol?.registries ||
      card?.onChainProtocol?.registries   ||
      card?.contracts                     ||
      null;
    if (legacyMap && typeof legacyMap === 'object') {
      for (const [k, v] of Object.entries(legacyMap)) {
        const addr = (typeof v === 'string') ? v : (v?.AgentRegistry || v?.agentRegistry);
        if (!addr) continue;
        // Resolve k → chainId (could be "56", "bsc", or 56)
        const id = (typeof k === 'string' && isNaN(parseInt(k)))
          ? listChains().find(c => c.key === k.toLowerCase())?.id
          : parseInt(k);
        if (id) cardRegistries[id] = cardRegistries[id] || addr;
      }
    }

    if (Object.keys(cardRegistries).length === 0) {
      wrn(`agent-card.json contains no recognisable chain→AgentRegistry mapping — drift check skipped`);
    } else {
      let drift = 0;
      let checked = 0;
      for (const ch of listChains()) {
        const fromCard  = cardRegistries[ch.id]?.toLowerCase();
        const fromChain = AGENT_REGISTRY[ch.id]?.toLowerCase();
        if (!fromCard) continue;
        checked++;
        if (fromCard === fromChain) {
          ok(`${ch.short.padEnd(5)} AgentRegistry: in sync`);
        } else {
          drift++;
          err(`${ch.short.padEnd(5)} DRIFT: card=${fmtAddr(fromCard)} chain=${fmtAddr(fromChain)}`);
        }
      }
      if (checked === 0) {
        wrn(`agent-card.json had a map but no entries matched supported chains — drift check skipped`);
      } else if (drift === 0) {
        ok(`All ${checked} declared address(es) match hardcoded AgentRegistry table`);
      }
    }
  } catch (e) {
    wrn(`Drift check skipped: ${e.message?.split('\n')[0]}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`${c.bold}Summary${c.reset}`);
  sep();
  const chainsUp = chainResults.filter(r => r.ok).length;
  const totalChains = chainResults.length;
  inf(`Chains:        ${chainsUp}/${totalChains} on-chain protocol readable`);
  inf(`A2A endpoints: ${okCount}/${pingResults.length} healthy`);
  if (pausedAny) wrn(`At least one chain has factoryPaused = true`);
  if (failCount > 0 || chainsUp < totalChains) {
    err(`Some checks failed — see above for details`);
    process.exit(1);
  } else {
    ok(`All systems operational · Level 5 Agent-Native compatible`);
  }
  console.log('');
}
