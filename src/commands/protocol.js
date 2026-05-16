// finchip protocol info — show full protocol state for a chain (on-chain + A2A surface)
import { loadConfig } from '../config.js';
import { resolveProtocol, getRegistryVersion } from '../discovery.js';
import { getPublicClient } from '../client.js';
import {
  AGENT_REGISTRY, AGENT_REGISTRY_ABI,
  FEE_ROUTER_ABI, MARKET_ABI,
} from '../protocol.js';
import { resolveChain } from '../chains.js';
import { A2A_ENDPOINTS, DEFAULT_BASE } from '../a2a-client.js';
import { ok, inf, hd, sep, fmtChain, fmtBool, fmtAddr, c } from '../utils.js';

export async function cmdProtocolInfo(options) {
  const cfg   = loadConfig();
  const chain = resolveChain(options.chain || cfg.chain);

  hd(`FinChip Protocol — ${fmtChain(chain.id)} (${chain.id})`);
  sep();

  const client = getPublicClient(chain.id, cfg.rpc);

  // ── Version + AgentRegistry ──────────────────────────────────────────────
  const version = await getRegistryVersion(chain.id, cfg.rpc);
  inf(`AgentRegistry version: ${c.cyan}${version ?? 'unknown'}${c.reset}`);
  inf(`AgentRegistry:         ${AGENT_REGISTRY[chain.id]}`);
  console.log('');

  // ── getProtocolExtended ──────────────────────────────────────────────────
  let proto;
  try {
    proto = await resolveProtocol(chain.id, cfg.rpc, true);
  } catch (e) {
    console.error(`${c.red} ✗${c.reset} Discovery failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }

  inf(`Protocol addresses (via ${c.cyan}AgentRegistry.${proto.source}()${c.reset}):`);
  inf(`  chipRegistry:    ${proto.chipRegistry}`);
  inf(`  factory:         ${proto.factory}`);
  inf(`  market:          ${proto.market}`);
  inf(`  feeRouter:       ${proto.feeRouter}`);
  if (proto.erc1155Deployer) {
    inf(`  erc1155Deployer: ${proto.erc1155Deployer}`);
    inf(`  erc721Deployer:  ${proto.erc721Deployer}`);
    inf(`  factoryPaused:   ${fmtBool(proto.factoryPaused)}`);
  }
  console.log('');

  // ── protocolSummaryV2 (catalog counts) ───────────────────────────────────
  try {
    const summary = await client.readContract({
      address:      AGENT_REGISTRY[chain.id],
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'protocolSummaryV2',
    });
    inf(`Protocol catalog state (${c.cyan}protocolSummaryV2()${c.reset}):`);
    inf(`  totalRegisteredAgents:   ${summary[5]}`);
    inf(`  totalRegisteredChips:    ${summary[6]}  (ERC-1155)`);
    inf(`  totalRegisteredChips721: ${summary[7]}  (ERC-721 fork)`);
    inf(`  factoryPaused:           ${fmtBool(summary[8])}`);
  } catch {
    // V2.3 fallback
    try {
      const summary = await client.readContract({
        address:      AGENT_REGISTRY[chain.id],
        abi:          AGENT_REGISTRY_ABI,
        functionName: 'protocolSummary',
      });
      inf(`Protocol catalog state (${c.cyan}protocolSummary()${c.reset}, V2.3):`);
      inf(`  totalRegisteredAgents: ${summary[5]}`);
      inf(`  totalRegisteredChips:  ${summary[6]}`);
    } catch { /* skip */ }
  }
  console.log('');

  // ── V2.5 hardening state ─────────────────────────────────────────────────
  try {
    const [treasuryLocked, platformTreasury, feeRouterLocked] = await Promise.all([
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'treasuryLocked'   }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'platformTreasury' }).catch(() => null),
      client.readContract({ address: proto.market,    abi: MARKET_ABI,     functionName: 'feeRouterLocked'  }).catch(() => null),
    ]);
    if (treasuryLocked !== null || feeRouterLocked !== null) {
      inf(`V2.5 hardening state:`);
      if (treasuryLocked  !== null) inf(`  FeeRouter.treasuryLocked:    ${fmtBool(treasuryLocked)}`);
      if (platformTreasury)         inf(`  FeeRouter.platformTreasury:  ${platformTreasury}`);
      if (feeRouterLocked !== null) inf(`  Market.feeRouterLocked:      ${fmtBool(feeRouterLocked)}`);
      console.log('');
    }
  } catch { /* best-effort */ }

  // ── Fee BPS constants (informational) ────────────────────────────────────
  try {
    const [mc, mp, ts, tc, tp] = await Promise.all([
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'MINT_CREATOR_BPS'   }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'MINT_PLATFORM_BPS'  }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'TRADE_SELLER_BPS'   }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'TRADE_CREATOR_BPS'  }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'TRADE_PLATFORM_BPS' }).catch(() => null),
    ]);
    if (mc !== null) {
      inf(`Fee split (BPS = basis points, 10000 = 100%):`);
      inf(`  Mint:  creator ${mc} / platform ${mp}`);
      inf(`  Trade: seller ${ts} / creator ${tc} / platform ${tp}`);
      console.log('');
    }
  } catch { /* best-effort */ }

  // ── A2A endpoint surface ─────────────────────────────────────────────────
  inf(`A2A protocol endpoints (network layer at ${c.cyan}${DEFAULT_BASE}${c.reset}):`);
  const grouped = {};
  for (const ep of A2A_ENDPOINTS) {
    if (!ep.critical) continue;
    (grouped[ep.group] = grouped[ep.group] || []).push(ep);
  }
  for (const [group, eps] of Object.entries(grouped)) {
    console.log(`  ${c.gray}${group}${c.reset}`);
    for (const ep of eps) {
      console.log(`    ${DEFAULT_BASE}${ep.path}`);
    }
  }
  console.log('');
  inf(`Run \`finchip doctor\` for live health-check of every endpoint + on-chain state.`);
  console.log('');
}
