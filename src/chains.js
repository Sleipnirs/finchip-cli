// FinChip CLI v0.3.0 — Chain configuration
// Single source of truth for all supported chains.
// Replaces scattered `chainId === 56 ? 'BNB' : 'ETH'` logic across the codebase.

import { bsc, base, mainnet, arbitrum, optimism, arbitrumSepolia } from 'viem/chains';

export const CHAINS = {
  56: {
    id: 56,
    key: 'bsc',
    name: 'BNB Smart Chain',
    short: 'BSC',
    symbol: 'BNB',
    viemChain: bsc,
    explorer: 'https://bscscan.com',
    // Ordered: primary first, fallbacks next. CLI tries them in order.
    rpcs: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.defibit.io',
    ],
    // Native USDC contract for x402 payments
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  8453: {
    id: 8453,
    key: 'base',
    name: 'Base',
    short: 'Base',
    symbol: 'ETH',
    viemChain: base,
    explorer: 'https://basescan.org',
    rpcs: [
      'https://base-rpc.publicnode.com',
      'https://mainnet.base.org',
    ],
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  1: {
    id: 1,
    key: 'ethereum',
    name: 'Ethereum Mainnet',
    short: 'ETH',
    symbol: 'ETH',
    viemChain: mainnet,
    explorer: 'https://etherscan.io',
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
    ],
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  42161: {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum One',
    short: 'Arb',
    symbol: 'ETH',
    viemChain: arbitrum,
    explorer: 'https://arbiscan.io',
    rpcs: [
      'https://arbitrum-one.publicnode.com',
      'https://arb1.arbitrum.io/rpc',
    ],
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  10: {
    id: 10,
    key: 'optimism',
    name: 'Optimism',
    short: 'OP',
    symbol: 'ETH',
    viemChain: optimism,
    explorer: 'https://optimistic.etherscan.io',
    rpcs: [
      'https://optimism-rpc.publicnode.com',
      'https://mainnet.optimism.io',
    ],
    usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  // ── Internal testnet ──────────────────────────────────────────────────────
  // Arbitrum Sepolia hosts a V2.5 fresh-bootstrap deployment for internal
  // testing (2026-06-17). All 7 contracts redeployed (no sticky); treasury
  // is the deployer EOA, not a Safe. Use `--chain arbsepolia` to operate it.
  // USDC is Circle's testnet contract; x402 flows work against Coinbase's
  // x402 sandbox if a server publishes a `bnb`-style accepts entry for it.
  421614: {
    id: 421614,
    key: 'arbsepolia',
    name: 'Arbitrum Sepolia (testnet)',
    short: 'ArbSep',
    symbol: 'ETH',
    viemChain: arbitrumSepolia,
    explorer: 'https://sepolia.arbiscan.io',
    rpcs: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
    ],
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // Circle Arb Sepolia USDC
    isTestnet: true,
  },
};

// Reverse lookup: chain key (string) -> chainId (number)
export const CHAIN_KEYS = Object.fromEntries(
  Object.values(CHAINS).map(c => [c.key, c.id])
);

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAINS).map(Number);

export const DEFAULT_CHAIN = 56; // BSC — cheapest gas, most active

/**
 * Resolve a chain identifier (number, string ID, or chain key) to chain metadata.
 * Throws if unsupported.
 */
export function resolveChain(input) {
  if (input === undefined || input === null) input = DEFAULT_CHAIN;
  const id = typeof input === 'string' && CHAIN_KEYS[input.toLowerCase()]
    ? CHAIN_KEYS[input.toLowerCase()]
    : parseInt(input);
  if (!CHAINS[id]) {
    throw new Error(
      `Unsupported chain: ${input}. Supported: ${SUPPORTED_CHAIN_IDS.join(', ')} ` +
      `(${Object.values(CHAINS).map(c => c.short).join(' / ')})`
    );
  }
  return CHAINS[id];
}

export function listChains() {
  return Object.values(CHAINS);
}

export function getSymbol(chainId)   { return CHAINS[chainId]?.symbol   || 'ETH'; }
export function getShortName(chainId) { return CHAINS[chainId]?.short    || `Chain ${chainId}`; }
export function getFullName(chainId)  { return CHAINS[chainId]?.name     || `Chain ${chainId}`; }
export function getExplorer(chainId)  { return CHAINS[chainId]?.explorer || null; }
export function getRpcs(chainId)      { return CHAINS[chainId]?.rpcs     || []; }
export function getUsdc(chainId)      { return CHAINS[chainId]?.usdc     || null; }
