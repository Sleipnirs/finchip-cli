import { getAddress, isAddress } from 'viem';

import { normalizeApiOrigin } from './auth-client.js';
import { CHIP_ABI, CHIP_721_ABI } from './protocol.js';
import { siteLookupSlug } from './skill-slug.js';
import { CliError } from './utils.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const INITIAL_BATCH_SIZE = 100;
const MINIMUM_BATCH_SIZE = 25;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class LibraryError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'LibraryError';
  }
}

function catalogFailure(message = 'FinChip active Skill catalog is temporarily unavailable.') {
  return new LibraryError('LIBRARY_SERVICE_UNAVAILABLE', message, 5);
}

function normalizedAddress(value) {
  if (!isAddress(value || '', { strict: false })) return null;
  return getAddress(String(value).toLowerCase());
}

function validateCatalogRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const contractAddr = normalizedAddress(row.contract_addr ?? row.contractAddr);
  const creatorAddr = normalizedAddress(row.creator_addr ?? row.creatorAddr);
  const chainId = Number(row.chain_id ?? row.chainId);
  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!contractAddr || contractAddr.toLowerCase() === ZERO_ADDRESS || !creatorAddr) return null;
  if (!Number.isInteger(chainId) || chainId <= 0 || !slug) return null;
  if (
    (row.price_wei ?? row.priceWei) != null
    && typeof (row.price_wei ?? row.priceWei) !== 'string'
    && typeof (row.price_wei ?? row.priceWei) !== 'number'
  ) return null;
  return {
    id: row.id ?? null,
    contractAddr,
    chainId,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : slug,
    slug: siteLookupSlug(slug),
    creatorAddr,
    priceWei: row.price_wei ?? row.priceWei ?? null,
    sourceUrl: typeof (row.source_url ?? row.sourceUrl) === 'string'
      ? (row.source_url ?? row.sourceUrl)
      : null,
    metadataUri: typeof (row.metadata_uri ?? row.metadataUri) === 'string'
      ? (row.metadata_uri ?? row.metadataUri)
      : null,
    createdAt: typeof (row.created_at ?? row.createdAt) === 'string'
      ? (row.created_at ?? row.createdAt)
      : null,
  };
}

export class LibraryCatalogClient {
  constructor(options = {}) {
    this.origin = normalizeApiOrigin(options.origin);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async list(options = {}) {
    const url = new URL('/api/chips/metrics', `${this.origin}/`);
    url.searchParams.set('all', '1');
    url.searchParams.set('fields', 'scan');
    if (options.chainId != null) url.searchParams.set('chain_id', String(options.chainId));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let text;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      throw catalogFailure();
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      throw catalogFailure('FinChip active Skill catalog refused an unexpected redirect.');
    }
    if (!response.ok) throw catalogFailure();

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw catalogFailure('FinChip active Skill catalog returned invalid JSON.');
    }
    if (!Array.isArray(payload?.chips)) {
      throw catalogFailure('FinChip active Skill catalog returned an invalid response.');
    }

    const unique = new Map();
    for (const rawRow of payload.chips) {
      const row = validateCatalogRow(rawRow);
      if (!row) {
        throw catalogFailure('FinChip active Skill catalog contained an invalid Chip entry.');
      }
      const key = `${row.chainId}:${row.contractAddr.toLowerCase()}`;
      if (!unique.has(key)) unique.set(key, row);
    }
    return [...unique.values()];
  }
}

function successful(result) {
  return result?.status === 'success';
}

function bigintResult(result) {
  if (!successful(result)) return null;
  try {
    return BigInt(result.result);
  } catch {
    return null;
  }
}

function nextBatchSize(size) {
  if (size > 50) return 50;
  return MINIMUM_BATCH_SIZE;
}

async function batchedMulticall(client, items, buildContracts, blockNumber, batchSize = INITIAL_BATCH_SIZE) {
  const output = new Map();

  async function runChunk(chunk, size) {
    const contractsByItem = chunk.map(item => buildContracts(item));
    const contracts = contractsByItem.flat();
    try {
      const results = await client.multicall({
        contracts,
        allowFailure: true,
        blockNumber,
      });
      let offset = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        const count = contractsByItem[index].length;
        output.set(chunk[index].contractAddr.toLowerCase(), results.slice(offset, offset + count));
        offset += count;
      }
    } catch {
      if (size > MINIMUM_BATCH_SIZE) {
        const smaller = nextBatchSize(size);
        for (let index = 0; index < chunk.length; index += smaller) {
          await runChunk(chunk.slice(index, index + smaller), smaller);
        }
        return;
      }
      for (const item of chunk) output.set(item.contractAddr.toLowerCase(), null);
    }
  }

  for (let index = 0; index < items.length; index += batchSize) {
    await runChunk(items.slice(index, index + batchSize), batchSize);
  }
  return output;
}

function erc1155BalanceCalls(chip, walletAddress) {
  return [0n, 1n].map(tokenId => ({
    address: chip.contractAddr,
    abi: CHIP_ABI,
    functionName: 'balanceOf',
    args: [walletAddress, tokenId],
  }));
}

function erc721BalanceCall(chip, walletAddress) {
  return [{
    address: chip.contractAddr,
    abi: CHIP_721_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  }];
}

function retryToken0Call(chip, walletAddress) {
  return [{
    address: chip.contractAddr,
    abi: CHIP_ABI,
    functionName: 'balanceOf',
    args: [walletAddress, 0n],
  }];
}

function metadataCalls(holding) {
  const erc721 = holding.tokenStandard === 'ERC-721';
  return [
    {
      address: holding.contractAddr,
      abi: erc721 ? CHIP_721_ABI : CHIP_ABI,
      functionName: 'creator',
    },
    {
      address: holding.contractAddr,
      abi: erc721 ? CHIP_721_ABI : CHIP_ABI,
      functionName: erc721 ? 'forkPrice' : 'licensePrice',
    },
  ];
}

function warning(code, chainId, message, contractAddr = null) {
  return {
    code,
    chainId,
    contractAddr,
    message,
  };
}

function exactCatalogWei(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function holdingRole(creatorBalance, licenseBalance) {
  const creator = creatorBalance != null && creatorBalance > 0n;
  const holder = licenseBalance > 0n;
  if (creator && holder) return 'both';
  if (creator) return 'creator';
  return 'holder';
}

async function scanChain({ chain, chips, walletAddress, client }) {
  const warnings = [];
  if (chips.length === 0) {
    return {
      chainId: chain.id,
      chainName: chain.name,
      snapshotBlock: null,
      candidates: 0,
      failed: 0,
      metadataFailed: 0,
      holdings: [],
      complete: true,
      trustworthy: true,
      warnings,
    };
  }

  let blockNumber;
  try {
    blockNumber = await client.getBlockNumber();
  } catch {
    return {
      chainId: chain.id,
      chainName: chain.name,
      snapshotBlock: null,
      candidates: chips.length,
      failed: chips.length,
      metadataFailed: 0,
      holdings: [],
      complete: false,
      trustworthy: false,
      warnings: [
        warning('CHAIN_RPC_UNAVAILABLE', chain.id, 'Could not pin a chain snapshot for Library scanning.'),
      ],
    };
  }

  const firstPass = await batchedMulticall(
    client,
    chips,
    chip => erc1155BalanceCalls(chip, walletAddress),
    blockNumber,
  );
  const token0Retries = [];
  const erc721Fallbacks = [];
  const balances = new Map();

  for (const chip of chips) {
    const key = chip.contractAddr.toLowerCase();
    const result = firstPass.get(key);
    if (!result) {
      erc721Fallbacks.push(chip);
      continue;
    }
    const token0 = bigintResult(result[0]);
    const token1 = bigintResult(result[1]);
    if (token0 != null || token1 != null) {
      const entry = {
        tokenStandard: 'ERC-1155',
        creatorBalance: token0,
        licenseBalance: token1 ?? 0n,
      };
      balances.set(key, entry);
      if (token0 == null && token1 != null) token0Retries.push(chip);
      continue;
    }
    erc721Fallbacks.push(chip);
  }

  if (token0Retries.length) {
    const retries = await batchedMulticall(
      client,
      token0Retries,
      chip => retryToken0Call(chip, walletAddress),
      blockNumber,
    );
    for (const chip of token0Retries) {
      const key = chip.contractAddr.toLowerCase();
      const token0 = bigintResult(retries.get(key)?.[0]);
      const entry = balances.get(key);
      entry.creatorBalance = token0;
      if (token0 == null) {
        warnings.push(warning(
          'BALANCE_PARTIAL',
          chain.id,
          'Token 0 balance could not be confirmed; the known token 1 balance is retained.',
          chip.contractAddr,
        ));
      }
    }
  }

  if (erc721Fallbacks.length) {
    const fallback = await batchedMulticall(
      client,
      erc721Fallbacks,
      chip => erc721BalanceCall(chip, walletAddress),
      blockNumber,
    );
    for (const chip of erc721Fallbacks) {
      const balance = bigintResult(fallback.get(chip.contractAddr.toLowerCase())?.[0]);
      if (balance != null) {
        balances.set(chip.contractAddr.toLowerCase(), {
          tokenStandard: 'ERC-721',
          balance,
        });
      } else {
        warnings.push(warning(
          'BALANCE_UNAVAILABLE',
          chain.id,
          'Neither ERC-1155 nor ERC-721 balance could be confirmed for this catalog entry.',
          chip.contractAddr,
        ));
      }
    }
  }

  const holdings = [];
  for (const chip of chips) {
    const balance = balances.get(chip.contractAddr.toLowerCase());
    if (!balance) continue;
    if (balance.tokenStandard === 'ERC-721') {
      if (balance.balance <= 0n) continue;
      holdings.push({
        ...chip,
        tokenStandard: 'ERC-721',
        role: 'holder',
        balance: balance.balance,
        creatorBalance: null,
        licenseBalance: null,
      });
      continue;
    }
    const creatorBalance = balance.creatorBalance;
    const licenseBalance = balance.licenseBalance;
    if ((creatorBalance == null || creatorBalance <= 0n) && licenseBalance <= 0n) continue;
    holdings.push({
      ...chip,
      tokenStandard: 'ERC-1155',
      role: holdingRole(creatorBalance, licenseBalance),
      balance: null,
      creatorBalance,
      licenseBalance,
    });
  }

  let metadataFailed = 0;
  if (holdings.length) {
    const metadata = await batchedMulticall(
      client,
      holdings,
      metadataCalls,
      blockNumber,
    );
    for (const holding of holdings) {
      const result = metadata.get(holding.contractAddr.toLowerCase());
      const creator = successful(result?.[0])
        ? normalizedAddress(result[0].result)
        : null;
      const price = bigintResult(result?.[1]);
      holding.metadataSource = {
        creator: creator ? 'chain' : 'catalog',
        price: price != null ? 'chain' : 'unavailable',
      };
      if (creator) {
        if (creator.toLowerCase() !== holding.creatorAddr.toLowerCase()) {
          warnings.push(warning(
            'CATALOG_STALE',
            chain.id,
            'Catalog creator differs from the authoritative on-chain creator.',
            holding.contractAddr,
          ));
        }
        holding.creatorAddr = creator;
      } else {
        metadataFailed += 1;
        warnings.push(warning(
          'METADATA_PARTIAL',
          chain.id,
          'On-chain creator could not be read; the catalog creator is retained.',
          holding.contractAddr,
        ));
      }
      const catalogWei = exactCatalogWei(holding.priceWei);
      if (price != null) {
        const priceWei = price.toString();
        if (catalogWei != null && catalogWei !== priceWei) {
          warnings.push(warning(
            'CATALOG_STALE',
            chain.id,
            'Catalog price differs from the authoritative on-chain price.',
            holding.contractAddr,
          ));
        }
        holding.priceWei = priceWei;
      } else {
        metadataFailed += 1;
        holding.priceWei = null;
        warnings.push(warning(
          'METADATA_PARTIAL',
          chain.id,
          'Exact on-chain price could not be read; no catalog display value is reported as exact wei.',
          holding.contractAddr,
        ));
      }
    }
  }

  const failedAddresses = new Set(
    warnings
      .filter(entry => entry.code === 'BALANCE_UNAVAILABLE' || entry.code === 'BALANCE_PARTIAL')
      .map(entry => entry.contractAddr?.toLowerCase())
      .filter(Boolean),
  );
  const fullyClassified = chips.length - warnings.filter(entry => entry.code === 'BALANCE_UNAVAILABLE').length;
  return {
    chainId: chain.id,
    chainName: chain.name,
    snapshotBlock: blockNumber.toString(),
    candidates: chips.length,
    failed: failedAddresses.size,
    metadataFailed,
    holdings,
    complete: failedAddresses.size === 0 && metadataFailed === 0,
    trustworthy: chips.length === 0 || fullyClassified > 0,
    warnings,
  };
}

function serializeHolding(holding) {
  return {
    slug: holding.slug,
    name: holding.name,
    chainId: holding.chainId,
    contractAddr: holding.contractAddr,
    tokenStandard: holding.tokenStandard,
    role: holding.role,
    balance: holding.balance == null ? null : holding.balance.toString(),
    creatorBalance: holding.creatorBalance == null ? null : holding.creatorBalance.toString(),
    licenseBalance: holding.licenseBalance == null ? null : holding.licenseBalance.toString(),
    creatorAddr: holding.creatorAddr,
    priceWei: holding.priceWei,
    sourceUrl: holding.sourceUrl,
    metadataUri: holding.metadataUri,
    metadataSource: holding.metadataSource,
  };
}

export async function scanLibrary({
  walletAddress,
  chains,
  catalogClient,
  publicClientFactory,
}) {
  const normalizedWallet = normalizedAddress(walletAddress);
  if (!normalizedWallet) {
    throw new LibraryError('LIBRARY_INVALID', 'A valid --wallet address is required.', 3);
  }
  const selectedChainIds = new Set(chains.map(chain => chain.id));
  const rawCatalogRows = await catalogClient.list({
    chainId: chains.length === 1 ? chains[0].id : undefined,
  });
  const catalogByDeployment = new Map();
  for (const rawRow of rawCatalogRows) {
    const row = validateCatalogRow(rawRow);
    if (!row) throw catalogFailure('FinChip active Skill catalog contained an invalid Chip entry.');
    const key = `${row.chainId}:${row.contractAddr.toLowerCase()}`;
    if (!catalogByDeployment.has(key)) catalogByDeployment.set(key, row);
  }
  const catalogRows = [...catalogByDeployment.values()];
  const warnings = [];
  const rows = catalogRows.filter(row => {
    if (selectedChainIds.has(row.chainId)) return true;
    warnings.push(warning(
      'UNSUPPORTED_CATALOG_CHAIN',
      row.chainId,
      'The active catalog contains a chain unsupported by this CLI.',
      row.contractAddr,
    ));
    return false;
  });

  const chainResults = [];
  for (const chain of chains) {
    const chainRows = rows.filter(row => row.chainId === chain.id);
    const result = await scanChain({
      chain,
      chips: chainRows,
      walletAddress: normalizedWallet,
      client: publicClientFactory(chain.id),
    });
    chainResults.push(result);
    warnings.push(...result.warnings);
  }

  if (!chainResults.some(result => result.trustworthy)) {
    throw catalogFailure('No requested chain produced a trustworthy Library scan.');
  }
  const holdings = chainResults.flatMap(result => result.holdings).map(serializeHolding);
  const complete = warnings.every(entry => entry.code === 'CATALOG_STALE')
    && chainResults.every(result => result.complete);
  const totals = {
    holdings: holdings.length,
    erc1155CreatorBalance: holdings
      .reduce((sum, holding) => sum + BigInt(holding.creatorBalance ?? 0), 0n)
      .toString(),
    erc1155LicenseBalance: holdings
      .reduce((sum, holding) => sum + BigInt(holding.licenseBalance ?? 0), 0n)
      .toString(),
    erc721Balance: holdings
      .reduce((sum, holding) => sum + BigInt(holding.balance ?? 0), 0n)
      .toString(),
    candidates: chainResults.reduce((sum, result) => sum + result.candidates, 0),
    failed: chainResults.reduce((sum, result) => sum + result.failed, 0),
    metadataFailed: chainResults.reduce((sum, result) => sum + result.metadataFailed, 0),
  };
  return {
    ok: true,
    code: complete ? 'LIBRARY_COMPLETE' : 'LIBRARY_PARTIAL',
    complete,
    wallet: normalizedWallet,
    catalog: {
      source: 'site-active-catalog',
      origin: catalogClient.origin ?? null,
      candidates: catalogRows.length,
    },
    chains: chainResults.map(result => ({
      chainId: result.chainId,
      chainName: result.chainName,
      snapshotBlock: result.snapshotBlock,
      candidates: result.candidates,
      failed: result.failed,
      metadataFailed: result.metadataFailed,
      holdings: result.holdings.length,
      complete: result.complete,
    })),
    holdings,
    totals,
    warnings,
  };
}
