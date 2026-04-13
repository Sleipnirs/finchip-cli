import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, base } from 'viem/chains';
import { RPCS } from './contracts.js';

const CHAINS = { 56: bsc, 8453: base };

export function getPublicClient(chainId, rpcOverride) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}. Use 56 (BSC) or 8453 (Base).`);
  const transport = http(rpcOverride || RPCS[chainId]);
  return createPublicClient({ chain, transport });
}

export function getWalletClient(chainId, privateKey, rpcOverride) {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}. Use 56 (BSC) or 8453 (Base).`);
  const account   = privateKeyToAccount(privateKey);
  const transport = http(rpcOverride || RPCS[chainId]);
  return { client: createWalletClient({ account, chain, transport }), account };
}

export { parseEther, privateKeyToAccount };
