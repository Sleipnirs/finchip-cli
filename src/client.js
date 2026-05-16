// FinChip CLI v0.3.0 — viem client factory
// Supports all 5 EVM mainnets with automatic RPC fallback.

import { createPublicClient, createWalletClient, http, fallback, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveChain, getRpcs } from './chains.js';

/**
 * Build a transport — single http() if custom RPC given, otherwise
 * fallback() across all configured public RPCs for the chain.
 */
function buildTransport(chainId, rpcOverride) {
  if (rpcOverride) return http(rpcOverride);
  const urls = getRpcs(chainId);
  if (urls.length === 0) throw new Error(`No RPCs configured for chain ${chainId}`);
  if (urls.length === 1) return http(urls[0]);
  return fallback(urls.map(u => http(u)), { rank: false });
}

/** Public read-only client (no wallet) */
export function getPublicClient(chainId, rpcOverride) {
  const chain = resolveChain(chainId);
  return createPublicClient({
    chain: chain.viemChain,
    transport: buildTransport(chain.id, rpcOverride),
  });
}

/** Wallet client + bound account from a 0x-prefixed private key */
export function getWalletClient(chainId, privateKey, rpcOverride) {
  const chain = resolveChain(chainId);
  if (!privateKey?.startsWith('0x') || privateKey.length !== 66) {
    throw new Error('Invalid private key: must be 0x-prefixed 64-hex-char string');
  }
  const account   = privateKeyToAccount(privateKey);
  const transport = buildTransport(chain.id, rpcOverride);
  const client    = createWalletClient({
    account,
    chain: chain.viemChain,
    transport,
  });
  return { client, account };
}

export { parseEther, formatEther, privateKeyToAccount };
