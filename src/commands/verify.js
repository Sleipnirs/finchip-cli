// finchip verify — confirm fc_key registration + show protocol state
import { loadConfig, keyToBytes32, keyToDisplay } from '../config.js';
import { resolveProtocol, getRegistryVersion } from '../discovery.js';
import { getPublicClient } from '../client.js';
import {
  AGENT_REGISTRY, AGENT_REGISTRY_ABI,
  FEE_ROUTER_ABI, MARKET_ABI,
} from '../protocol.js';
import { resolveChain } from '../chains.js';
import {
  ok, err, inf, hd, sep, fmtAddr, fmtPerms, fmtChain, fmtBool, fmtWalletType, c,
} from '../utils.js';

export async function cmdVerify(options) {
  const cfg   = loadConfig();
  const chain = resolveChain(options.chain || cfg.chain);
  let keyRaw;
  try {
    keyRaw = options.key ? keyToBytes32(options.key) : cfg.keyRaw;
  } catch (e) { err(e.message); process.exit(1); }

  if (!keyRaw) {
    err('No fc_key found. Run: finchip init --key fc_xxxxx');
    process.exit(1);
  }

  const displayKey = keyToDisplay(keyRaw);

  hd(`FinChip CLI — verify`);
  sep();
  inf(`key:      ${displayKey}`);
  inf(`chain:    ${fmtChain(chain.id)} (${chain.id})`);
  inf(`registry: ${AGENT_REGISTRY[chain.id]}`);
  console.log('');

  const client = getPublicClient(chain.id, cfg.rpc);

  // ── fc_key entry ─────────────────────────────────────────────────────────
  let agent;
  try {
    agent = await client.readContract({
      address:      AGENT_REGISTRY[chain.id],
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'verify',
      args:         [keyRaw],
    });
  } catch (e) {
    err(`fc_key not active on-chain: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    inf(`Run: finchip register --perm full`);
    process.exit(1);
  }

  if (!agent.active) {
    err(`fc_key exists but is inactive (revoked)`);
    process.exit(1);
  }

  ok(`fc_key is ACTIVE on ${fmtChain(chain.id)}`);
  inf(`wallet:      ${agent.wallet}`);
  inf(`permissions: ${fmtPerms(agent.permissions)} (0x${agent.permissions.toString(16).padStart(2,'0')})`);
  inf(`walletType:  ${fmtWalletType(agent.walletType)}`);
  inf(`registered:  ${new Date(Number(agent.registeredAt) * 1000).toISOString()}`);
  inf(`label:       ${agent.label || '—'}`);
  console.log('');

  // ── Protocol discovery via AgentRegistry ─────────────────────────────────
  let proto;
  try {
    proto = await resolveProtocol(chain.id, cfg.rpc, true);
    const ver = await getRegistryVersion(chain.id, cfg.rpc);
    inf(`Protocol (${ver ?? 'unknown version'}, via ${proto.source}):`);
    inf(`  chipRegistry:    ${proto.chipRegistry}`);
    inf(`  factory:         ${proto.factory}`);
    inf(`  market:          ${proto.market}`);
    inf(`  feeRouter:       ${proto.feeRouter}`);
    if (proto.erc1155Deployer) {
      inf(`  erc1155Deployer: ${proto.erc1155Deployer}`);
      inf(`  erc721Deployer:  ${proto.erc721Deployer}`);
      inf(`  factoryPaused:   ${fmtBool(proto.factoryPaused)}`);
    }
  } catch (e) {
    err(`Protocol discovery failed: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
  console.log('');

  // ── V2.5 hardening state (informational) ─────────────────────────────────
  try {
    const [
      treasuryLocked, platformTreasury,
      feeRouterLocked, marketFeeRouter,
    ] = await Promise.all([
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'treasuryLocked'    }).catch(() => null),
      client.readContract({ address: proto.feeRouter, abi: FEE_ROUTER_ABI, functionName: 'platformTreasury'  }).catch(() => null),
      client.readContract({ address: proto.market,    abi: MARKET_ABI,     functionName: 'feeRouterLocked'   }).catch(() => null),
      client.readContract({ address: proto.market,    abi: MARKET_ABI,     functionName: 'feeRouter'         }).catch(() => null),
    ]);
    if (treasuryLocked !== null) {
      inf(`V2.5 hardening:`);
      inf(`  FeeRouter.treasuryLocked:   ${fmtBool(treasuryLocked)}`);
      if (platformTreasury) inf(`  FeeRouter.platformTreasury: ${platformTreasury}`);
      inf(`  Market.feeRouterLocked:     ${fmtBool(feeRouterLocked)}`);
      if (marketFeeRouter !== proto.feeRouter && marketFeeRouter) {
        inf(`  ${c.yellow}⚠ Market.feeRouter (${fmtAddr(marketFeeRouter)}) ≠ protocol.feeRouter (${fmtAddr(proto.feeRouter)})${c.reset}`);
      }
    }
  } catch { /* V2.5 checks are best-effort */ }
  console.log('');
}
