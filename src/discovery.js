// FinChip CLI v0.3.0 — Discovery layer
// =====================================
// This is the central nervous system of v0.3.0.
//
// Every command calls resolveProtocol(chainId) instead of reading hardcoded
// addresses. resolveProtocol() calls AgentRegistry.getProtocolExtended() on
// the requested chain and caches the result for 5 minutes.
//
// Benefits:
//   • Future V2.6+ contract upgrades require ZERO CLI changes
//   • finchip doctor can spot drift between layers
//   • CLI works even when finchip.ai is down (we only depend on the chain)

import { AGENT_REGISTRY, AGENT_REGISTRY_ABI } from './protocol.js';
import { getPublicClient } from './client.js';
import { resolveChain } from './chains.js';

// ── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map(); // chainId -> { addresses, fetchedAt, version }
const TTL_MS = 5 * 60 * 1000;

/**
 * Resolve all protocol addresses for a chain via AgentRegistry.getProtocolExtended().
 *
 * Returns:
 *   {
 *     chainId,
 *     agentRegistry,
 *     chipRegistry,
 *     factory,
 *     market,
 *     feeRouter,
 *     erc1155Deployer,
 *     erc721Deployer,
 *     factoryPaused,
 *     fetchedAt,
 *   }
 *
 * @param {number} chainId   Target chain
 * @param {string=} rpcOverride  Optional custom RPC
 * @param {boolean=} force  Skip cache
 */
export async function resolveProtocol(chainId, rpcOverride, force = false) {
  const chain = resolveChain(chainId);
  const agentRegistry = AGENT_REGISTRY[chain.id];
  if (!agentRegistry) {
    throw new Error(`No AgentRegistry hardcoded for chain ${chain.id}`);
  }

  // Cache check
  const cached = cache.get(chain.id);
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached;
  }

  const client = getPublicClient(chain.id, rpcOverride);

  // Try V2.4 getProtocolExtended first (best path).
  // Fall back to V2.3 getProtocol if extended is unavailable (defensive — should
  // never happen on currently-deployed V2.4 registries, but future-proofs us
  // against any chain we add where the registry is still V2.3).
  let addresses;
  try {
    const [
      chipRegistry, factory, market, feeRouter,
      erc1155Deployer, erc721Deployer, factoryPaused,
    ] = await client.readContract({
      address:      agentRegistry,
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'getProtocolExtended',
    });
    addresses = {
      chainId:         chain.id,
      agentRegistry,
      chipRegistry,
      factory,
      market,
      feeRouter,
      erc1155Deployer,
      erc721Deployer,
      factoryPaused,
      fetchedAt:       Date.now(),
      source:          'getProtocolExtended',
    };
  } catch (_) {
    const [chipRegistry, factory, market, feeRouter] = await client.readContract({
      address:      agentRegistry,
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'getProtocol',
    });
    addresses = {
      chainId:         chain.id,
      agentRegistry,
      chipRegistry,
      factory,
      market,
      feeRouter,
      erc1155Deployer: null,
      erc721Deployer:  null,
      factoryPaused:   null,
      fetchedAt:       Date.now(),
      source:          'getProtocol',
    };
  }

  cache.set(chain.id, addresses);
  return addresses;
}

/** Bulk-resolve all 5 chains (used by `finchip doctor` and `finchip protocol info`) */
export async function resolveAllChains() {
  const ids = Object.keys(AGENT_REGISTRY).map(Number);
  const results = await Promise.allSettled(ids.map(id => resolveProtocol(id)));
  return ids.map((id, i) => ({
    chainId: id,
    ok:      results[i].status === 'fulfilled',
    data:    results[i].status === 'fulfilled' ? results[i].value  : null,
    error:   results[i].status === 'rejected'  ? results[i].reason : null,
  }));
}

/** Get on-chain VERSION constant from AgentRegistry */
export async function getRegistryVersion(chainId, rpcOverride) {
  const chain = resolveChain(chainId);
  const client = getPublicClient(chain.id, rpcOverride);
  try {
    return await client.readContract({
      address:      AGENT_REGISTRY[chain.id],
      abi:          AGENT_REGISTRY_ABI,
      functionName: 'VERSION',
    });
  } catch {
    return null;
  }
}

/** Clear cache (mostly for tests / doctor with --force) */
export function clearCache() {
  cache.clear();
}
