import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LibraryCatalogClient,
  LibraryError,
  scanLibrary,
} from '../src/library-scan.js';
import { cmdLibrary } from '../src/commands/library.js';

const WALLET = '0x9999999999999999999999999999999999999999';
const CREATOR = '0x8888888888888888888888888888888888888888';

function address(index) {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function chip(index, overrides = {}) {
  return {
    id: `chip-${index}`,
    contract_addr: address(index),
    chain_id: 56,
    name: `Chip ${index}`,
    slug: `chip-${index}-finchip`,
    creator_addr: CREATOR,
    price_wei: '100',
    source_url: `ipfs://source-${index}`,
    metadata_uri: `ipfs://metadata-${index}`,
    created_at: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function success(result) {
  return { status: 'success', result };
}

function failure(message = 'reverted') {
  return { status: 'failure', error: new Error(message) };
}

function mockPublicClient(handler, options = {}) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() {
      return options.blockNumber ?? 123n;
    },
    async multicall(input) {
      calls.push(input);
      if (options.throwWhenContractsExceed && input.contracts.length > options.throwWhenContractsExceed) {
        throw new Error('RPC payload too large');
      }
      return input.contracts.map(handler);
    },
  };
}

test('library scans large ERC-1155 catalogs in bounded dual-balance multicalls', async () => {
  const chips = Array.from({ length: 1001 }, (_, index) => chip(index + 1));
  const first = chips[0].contract_addr.toLowerCase();
  const client = mockPublicClient(contract => {
    const addr = contract.address.toLowerCase();
    if (contract.functionName === 'balanceOf' && contract.args.length === 2) {
      const tokenId = contract.args[1];
      return success(addr === first ? (tokenId === 0n ? 1n : 2n) : 0n);
    }
    if (contract.functionName === 'creator') return success(CREATOR);
    if (contract.functionName === 'licensePrice') return success(100n);
    throw new Error(`Unexpected call: ${contract.functionName}`);
  });

  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [{ id: 56, name: 'BNB Smart Chain' }],
    catalogClient: { list: async () => chips },
    publicClientFactory: () => client,
  });

  assert.equal(result.code, 'LIBRARY_COMPLETE');
  assert.equal(result.complete, true);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].role, 'both');
  const balanceBatches = client.calls.filter(call =>
    call.contracts.some(contract => contract.functionName === 'balanceOf'));
  assert.equal(balanceBatches.length, 11);
  assert.ok(balanceBatches.every(call => call.contracts.length <= 200));
  assert.equal(
    balanceBatches.flatMap(call => call.contracts).some(contract => contract.args.length === 1),
    false,
  );
  assert.equal(
    client.calls.flatMap(call => call.contracts).some(contract => contract.functionName === 'supportsInterface'),
    false,
  );
});

test('library falls back to ERC-721 only after both ERC-1155 calls fail', async () => {
  const [normal, legacy, erc721, token0Unknown, unsupported] =
    [1, 2, 3, 4, 5].map(index => chip(index));
  const byAddress = new Map([
    [normal.contract_addr.toLowerCase(), 'normal'],
    [legacy.contract_addr.toLowerCase(), 'legacy'],
    [erc721.contract_addr.toLowerCase(), 'erc721'],
    [token0Unknown.contract_addr.toLowerCase(), 'token0-unknown'],
    [unsupported.contract_addr.toLowerCase(), 'unsupported'],
  ]);
  const client = mockPublicClient(contract => {
    const kind = byAddress.get(contract.address.toLowerCase());
    if (contract.functionName === 'balanceOf' && contract.args.length === 2) {
      const tokenId = contract.args[1];
      if (kind === 'normal') return success(tokenId === 0n ? 1n : 2n);
      if (kind === 'legacy') return tokenId === 0n ? success(1n) : failure();
      if (kind === 'token0-unknown') return tokenId === 0n ? failure() : success(2n);
      return failure();
    }
    if (contract.functionName === 'balanceOf' && contract.args.length === 1) {
      return kind === 'erc721' ? success(1n) : failure();
    }
    if (contract.functionName === 'creator') {
      return kind === 'token0-unknown' ? failure() : success(CREATOR);
    }
    if (contract.functionName === 'licensePrice') {
      return kind === 'token0-unknown' ? failure() : success(100n);
    }
    if (contract.functionName === 'forkPrice') return success(100n);
    throw new Error(`Unexpected call: ${contract.functionName}`);
  });

  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [{ id: 56, name: 'BNB Smart Chain' }],
    catalogClient: { list: async () => [normal, legacy, erc721, token0Unknown, unsupported] },
    publicClientFactory: () => client,
  });

  assert.equal(result.code, 'LIBRARY_PARTIAL');
  assert.equal(result.ok, true);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.holdings.map(holding => [holding.contractAddr, holding.tokenStandard, holding.role]),
    [
      [normal.contract_addr, 'ERC-1155', 'both'],
      [legacy.contract_addr, 'ERC-1155', 'creator'],
      [erc721.contract_addr, 'ERC-721', 'holder'],
      [token0Unknown.contract_addr, 'ERC-1155', 'holder'],
    ],
  );
  const erc721Fallbacks = client.calls
    .flatMap(call => call.contracts)
    .filter(contract => contract.functionName === 'balanceOf' && contract.args.length === 1)
    .map(contract => contract.address.toLowerCase())
    .sort();
  assert.deepEqual(erc721Fallbacks, [
    erc721.contract_addr.toLowerCase(),
    unsupported.contract_addr.toLowerCase(),
  ].sort());
  assert.equal(result.holdings.at(-1).priceWei, null);
  assert.equal(result.holdings.at(-1).creatorAddr, CREATOR);
  assert.ok(result.warnings.some(warning => warning.code === 'BALANCE_PARTIAL'));
  assert.ok(result.warnings.some(warning => warning.code === 'METADATA_PARTIAL'));
});

test('library reduces whole failed batches from 100 to 50 without independent RPC fallback', async () => {
  const chips = Array.from({ length: 101 }, (_, index) => chip(index + 1));
  const client = mockPublicClient(contract => {
    if (contract.functionName === 'balanceOf') return success(0n);
    throw new Error(`Unexpected call: ${contract.functionName}`);
  }, { throwWhenContractsExceed: 100 });

  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [{ id: 56, name: 'BNB Smart Chain' }],
    catalogClient: { list: async () => chips },
    publicClientFactory: () => client,
  });

  assert.equal(result.code, 'LIBRARY_COMPLETE');
  assert.deepEqual(client.calls.map(call => call.contracts.length), [200, 100, 100, 2]);
});

test('library reduces a still-failing 50-address retry to 25-address batches', async () => {
  const chips = Array.from({ length: 30 }, (_, index) => chip(index + 1));
  const client = mockPublicClient(contract => {
    if (contract.functionName === 'balanceOf') return success(0n);
    throw new Error(`Unexpected call: ${contract.functionName}`);
  }, { throwWhenContractsExceed: 50 });

  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [{ id: 56, name: 'BNB Smart Chain' }],
    catalogClient: { list: async () => chips },
    publicClientFactory: () => client,
  });

  assert.equal(result.code, 'LIBRARY_COMPLETE');
  assert.deepEqual(client.calls.map(call => call.contracts.length), [60, 60, 50, 10]);
});

test('chain metadata is authoritative and catalog drift is disclosed', async () => {
  const staleCreator = '0x7777777777777777777777777777777777777777';
  const held = chip(1, { creator_addr: staleCreator, price_wei: '99' });
  const client = mockPublicClient(contract => {
    if (contract.functionName === 'balanceOf') {
      return success(contract.args[1] === 1n ? 1n : 0n);
    }
    if (contract.functionName === 'creator') return success(CREATOR);
    if (contract.functionName === 'licensePrice') return success(100n);
    throw new Error(`Unexpected call: ${contract.functionName}`);
  });

  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [{ id: 56, name: 'BNB Smart Chain' }],
    catalogClient: { list: async () => [held] },
    publicClientFactory: () => client,
  });

  assert.equal(result.code, 'LIBRARY_COMPLETE');
  assert.equal(result.holdings[0].creatorAddr, CREATOR);
  assert.equal(result.holdings[0].priceWei, '100');
  assert.equal(result.holdings[0].metadataSource.creator, 'chain');
  assert.equal(result.holdings[0].metadataSource.price, 'chain');
  assert.equal(result.warnings.filter(warning => warning.code === 'CATALOG_STALE').length, 2);
});

test('public catalog client is anonymous, deduplicates addresses, and rejects malformed data', async () => {
  const calls = [];
  const client = new LibraryCatalogClient({
    origin: 'https://finchip.ai/path',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return new Response(JSON.stringify({ chips: [chip(1), chip(1)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const rows = await client.list({ chainId: 56 });
  assert.equal(rows.length, 1);
  assert.equal(
    calls[0].url.href,
    'https://finchip.ai/api/chips/metrics?all=1&fields=scan&chain_id=56',
  );
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.has('Cookie'), false);
  assert.equal(calls[0].init.headers.has('Authorization'), false);
  assert.equal(calls[0].init.headers.has('Origin'), false);

  const malformed = new LibraryCatalogClient({
    fetchImpl: async () => new Response(JSON.stringify({ chips: [{ chain_id: 56 }] })),
  });
  await assert.rejects(
    () => malformed.list({}),
    error => error instanceof LibraryError && error.code === 'LIBRARY_SERVICE_UNAVAILABLE',
  );
});

test('public catalog client rejects redirects, upstream failures, and network errors', async () => {
  const responses = [
    new Response('', { status: 302, headers: { Location: 'https://other.test/' } }),
    new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
  ];
  for (const response of responses) {
    const client = new LibraryCatalogClient({ fetchImpl: async () => response });
    await assert.rejects(
      () => client.list({}),
      error => error instanceof LibraryError && error.code === 'LIBRARY_SERVICE_UNAVAILABLE',
    );
  }
  const offline = new LibraryCatalogClient({
    fetchImpl: async () => { throw new Error('Cookie=secret'); },
  });
  await assert.rejects(
    () => offline.list({}),
    error => error.code === 'LIBRARY_SERVICE_UNAVAILABLE'
      && !/Cookie|secret/.test(error.message),
  );
});

test('library aggregates empty multi-chain scans and discloses unsupported catalog chains', async () => {
  const clients = new Map([
    [56, mockPublicClient(() => success(0n), { blockNumber: 56n })],
    [10, mockPublicClient(() => success(0n), { blockNumber: 10n })],
  ]);
  const result = await scanLibrary({
    walletAddress: WALLET,
    chains: [
      { id: 56, name: 'BNB Smart Chain' },
      { id: 10, name: 'Optimism' },
    ],
    catalogClient: {
      list: async () => [
        chip(1, { chain_id: 56 }),
        chip(2, { chain_id: 10 }),
        chip(3, { chain_id: 999 }),
      ],
    },
    publicClientFactory: chainId => clients.get(chainId),
  });

  assert.equal(result.code, 'LIBRARY_PARTIAL');
  assert.equal(result.ok, true);
  assert.equal(result.holdings.length, 0);
  assert.deepEqual(result.chains.map(chain => chain.snapshotBlock), ['56', '10']);
  assert.equal(result.totals.candidates, 2);
  assert.ok(result.warnings.some(warning => warning.code === 'UNSUPPORTED_CATALOG_CHAIN'));
});

test('library partial JSON remains usable and exits successfully', { concurrency: false }, async () => {
  const confirmed = chip(1);
  const unsupported = chip(2);
  const client = mockPublicClient(contract =>
    contract.address.toLowerCase() === confirmed.contract_addr.toLowerCase()
      ? success(0n)
      : failure());
  const previousWrite = process.stdout.write;
  const previousExitCode = process.exitCode;
  let stdout = '';
  process.stdout.write = chunk => {
    stdout += String(chunk);
    return true;
  };
  process.exitCode = undefined;
  try {
    const result = await cmdLibrary(
      { wallet: WALLET, chain: 'bsc', json: true },
      {
        config: {},
        catalogClient: { list: async () => [confirmed, unsupported] },
        publicClientFactory: () => client,
      },
    );
    assert.equal(result.code, 'LIBRARY_PARTIAL');
    assert.equal(process.exitCode, undefined);
    assert.equal(JSON.parse(stdout).code, 'LIBRARY_PARTIAL');
    assert.equal(JSON.parse(stdout).complete, false);
    assert.doesNotMatch(stdout, /private.?key|cookie|authorization/i);
  } finally {
    process.stdout.write = previousWrite;
    process.exitCode = previousExitCode;
  }
});
