import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireSkill } from '../src/commands/acquire.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const TX_HASH = `0x${'ab'.repeat(32)}`;

function detail(overrides = {}) {
  return {
    requestedSlug: 'audit',
    canonicalSlug: 'audit_finchip',
    deployment: {
      acquirable: true,
      chainId: 8453,
      contractAddr: ADDR,
      ...overrides,
    },
  };
}

function publicClient(options = {}) {
  let held = options.held ?? 0n;
  return {
    async readContract(request) {
      switch (request.functionName) {
        case 'supportsInterface': return Boolean(options.is721);
        case 'licensePrice':
          if (options.is721) throw new Error('not ERC-1155');
          return options.price ?? 10n;
        case 'forkPrice':
          if (!options.is721) throw new Error('not ERC-721');
          return options.price ?? 10n;
        case 'totalMinted':
        case 'totalForked': return options.issued ?? 3n;
        case 'maxSupply':
        case 'maxForks': return options.capacity ?? 100n;
        case 'balanceOf': return held;
        default: throw new Error(`unexpected read ${request.functionName}`);
      }
    },
    async getBalance() { return options.walletBalance ?? 1_000_000n; },
    async simulateContract(request) {
      if (options.simulationError) throw new Error('secret revert payload');
      return { request };
    },
    async estimateContractGas() { return 21_000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 2n }; },
    async waitForTransactionReceipt() {
      if (options.waitError) throw new Error('timeout detail');
      if (options.receiptStatus === 'reverted') return { status: 'reverted', blockNumber: 9n };
      if (!options.noHoldingIncrease) held += 1n;
      return { status: 'success', blockNumber: 9n };
    },
  };
}

function dependencies(options = {}) {
  const calls = { chains: [], writes: 0 };
  const pub = options.publicClient || publicClient(options);
  return {
    calls,
    detailClient: { get: async () => options.detail || detail() },
    loadConfig: () => ({ chain: 56, rpc: 'mock-rpc' }),
    resolvePrivateKey: () => `0x${'11'.repeat(32)}`,
    accountFromPrivateKey: () => ({ address: WALLET }),
    publicClientFactory: chainId => {
      calls.chains.push(chainId);
      return pub;
    },
    walletClientFactory: chainId => {
      calls.walletChain = chainId;
      return {
        client: {
          async writeContract() {
            calls.writes += 1;
            return TX_HASH;
          },
        },
        account: { address: WALLET },
      };
    },
  };
}

test('acquire resolves Site canonical deployment and ignores the configured default chain', async () => {
  const deps = dependencies();
  const result = await acquireSkill({ slug: 'audit', dryRun: true }, deps);

  assert.equal(result.code, 'ACQUIRE_DRY_RUN');
  assert.equal(result.slug, 'audit_finchip');
  assert.equal(result.chainId, 8453);
  assert.deepEqual(deps.calls.chains, [8453]);
  assert.equal(deps.calls.writes, 0);
  assert.equal(result.priceWei, '10');
  assert.equal(result.estimatedGas, '21000');
  assert.equal(result.confirmationRequired, true);
});

test('acquire without --yes completes preflight but never signs or broadcasts', async () => {
  const deps = dependencies();
  await assert.rejects(
    () => acquireSkill({ slug: 'audit' }, deps),
    error => error.code === 'ACQUIRE_CONFIRM_REQUIRED'
      && error.details.chainId === 8453
      && error.details.priceWei === '10'
  );
  assert.equal(deps.calls.writes, 0);
});

test('acquire is idempotent for existing holdings unless force and yes are explicit', async () => {
  const deps = dependencies({ held: 1n, simulationError: true });
  const held = await acquireSkill({ slug: 'audit', yes: true }, deps);
  assert.equal(held.code, 'ACQUIRE_ALREADY_HELD');
  assert.equal(held.estimatedGas, null);
  assert.equal(deps.calls.writes, 0);

  const forced = dependencies({ held: 1n });
  const complete = await acquireSkill({ slug: 'audit', force: true, yes: true }, forced);
  assert.equal(complete.code, 'ACQUIRE_COMPLETE');
  assert.equal(complete.txHash, TX_HASH);
  assert.equal(forced.calls.writes, 1);
});

test('acquire maps preflight and post-broadcast failures to stable contracts', async () => {
  const insufficient = dependencies({ walletBalance: 9n });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', dryRun: true }, insufficient),
    error => error.code === 'INSUFFICIENT_FUNDS'
  );

  const uncertain = dependencies({ waitError: true });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', yes: true }, uncertain),
    error => error.code === 'ACQUIRE_RESULT_UNKNOWN'
      && error.details.txHash === TX_HASH
      && error.details.retrySafe === false
      && !/timeout detail/.test(error.message)
  );
});

test('acquire supports ERC-721, free purchases, sold-out, simulation, and receipt verification paths', async () => {
  const fork = dependencies({ is721: true, price: 0n });
  const forkResult = await acquireSkill({ slug: 'audit', dryRun: true }, fork);
  assert.equal(forkResult.tokenStandard, 'ERC-721');
  assert.equal(forkResult.purchaseMethod, 'purchaseFork');
  assert.equal(forkResult.priceWei, '0');

  const soldOut = dependencies({ issued: 4n, capacity: 4n });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', dryRun: true }, soldOut),
    error => error.code === 'ACQUIRE_SOLD_OUT'
  );

  const simulation = dependencies({ simulationError: true });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', dryRun: true }, simulation),
    error => error.code === 'ACQUIRE_SIMULATION_FAILED'
      && !/secret|payload/.test(error.message)
  );

  const reverted = dependencies({ receiptStatus: 'reverted' });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', yes: true }, reverted),
    error => error.code === 'ACQUIRE_TX_FAILED'
      && error.details.txHash === TX_HASH
  );

  const unverified = dependencies({ noHoldingIncrease: true });
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', yes: true }, unverified),
    error => error.code === 'ACQUIRE_VERIFY_FAILED'
      && error.details.txHash === TX_HASH
  );
});

test('acquire forwards an exact pair to public detail and requires a configured wallet afterward', async () => {
  let detailOptions;
  const deps = {
    detailClient: {
      get: async (_slug, options) => {
        detailOptions = options;
        return detail({ chainId: 56 });
      },
    },
    loadConfig: () => ({ chain: 8453 }),
    resolvePrivateKey: () => null,
  };
  await assert.rejects(
    () => acquireSkill({ slug: 'audit', chain: 'bsc', addr: ADDR, dryRun: true }, deps),
    error => error.code === 'WALLET_REQUIRED'
      && error.details.chainId === 56
  );
  assert.deepEqual(detailOptions, { chain: 'bsc', addr: ADDR });
});

test('acquire validates mutually exclusive and half-pair options before wallet or RPC access', async () => {
  let detailCalls = 0;
  let keyCalls = 0;
  const deps = {
    detailClient: { get: async () => { detailCalls += 1; return detail(); } },
    loadConfig: () => ({}),
    resolvePrivateKey: () => { keyCalls += 1; return null; },
  };
  for (const options of [
    { slug: 'audit', dryRun: true, yes: true },
    { slug: 'audit', chain: 'base' },
    { slug: 'audit', addr: ADDR },
  ]) {
    await assert.rejects(() => acquireSkill(options, deps), error => error.code === 'ACQUIRE_INVALID');
  }
  assert.equal(detailCalls, 0);
  assert.equal(keyCalls, 0);
});
