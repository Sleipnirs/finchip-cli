import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureTradeListingReady,
  TradePreflightError,
  TradePreflightPublicClient,
  verifyTradeListingCreator,
} from '../src/trade-preflight.js';

const INPUT = {
  chainId: 56,
  chipAddr: '0x1111111111111111111111111111111111111111',
  seller: '0x2222222222222222222222222222222222222222',
  tokenId: '1',
  quantity: '1',
  priceWei: '10000000000000',
  standard: 'erc1155',
};

test('public client sends only anonymous listing input and preserves Site errors', async () => {
  const calls = [];
  const client = new TradePreflightPublicClient({
    origin: 'http://127.0.0.1:3000',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: false,
        code: 'TRADE_INSUFFICIENT_AVAILABLE_BALANCE',
        error: 'Listing quantity exceeds available balance.',
        availableQuantity: '0',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await client.preflight(INPUT);
  assert.equal(result.code, 'TRADE_INSUFFICIENT_AVAILABLE_BALANCE');
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/api/v2/trade/listings/preflight');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Cookie, undefined);
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Origin, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), INPUT);
});

test('public client fails closed for network, 5xx, and malformed responses', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => new Response(JSON.stringify({ code: 'INTERNAL' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
    async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ]) {
    const client = new TradePreflightPublicClient({
      origin: 'http://127.0.0.1:3000',
      fetchImpl,
    });
    await assert.rejects(
      () => client.preflight(INPUT),
      error => error instanceof TradePreflightError
        && error.code === 'TRADE_PREFLIGHT_UNAVAILABLE',
    );
  }
});

test('listing orchestration rejects inventory before approval and never retries', async () => {
  let calls = 0;
  let approvals = 0;
  await assert.rejects(
    () => ensureTradeListingReady({
      preflight: async () => {
        calls += 1;
        return {
          ok: false,
          code: 'TRADE_INSUFFICIENT_AVAILABLE_BALANCE',
          error: 'Too many.',
        };
      },
      approve: async () => { approvals += 1; },
    }),
    error => error.code === 'TRADE_INSUFFICIENT_AVAILABLE_BALANCE',
  );
  assert.equal(calls, 1);
  assert.equal(approvals, 0);
});

test('listing orchestration approves once then requires a fresh successful preflight', async () => {
  const results = [
    {
      ok: false,
      code: 'TRADE_APPROVAL_REQUIRED',
      error: 'Approve first.',
      chainId: 56,
      marketAddr: '0x4444444444444444444444444444444444444444',
      chipAddr: INPUT.chipAddr,
      seller: INPUT.seller,
    },
    {
      ok: true,
      code: 'TRADE_LISTING_PREFLIGHT_OK',
      chainId: 56,
      marketAddr: '0x4444444444444444444444444444444444444444',
      chipAddr: INPUT.chipAddr,
      seller: INPUT.seller,
      creatorAddr: '0x3333333333333333333333333333333333333333',
      availableQuantity: '1',
      estimatedGas: '150000',
    },
  ];
  let approvals = 0;
  const ready = await ensureTradeListingReady({
    preflight: async () => results.shift(),
    approve: async () => { approvals += 1; },
    expected: {
      chainId: 56,
      marketAddr: '0x4444444444444444444444444444444444444444',
      chipAddr: INPUT.chipAddr,
      seller: INPUT.seller,
    },
  });

  assert.equal(approvals, 1);
  assert.equal(results.length, 0);
  assert.equal(ready.code, 'TRADE_LISTING_PREFLIGHT_OK');
});

test('listing orchestration fails closed if the post-approval preflight is unavailable', async () => {
  let calls = 0;
  await assert.rejects(
    () => ensureTradeListingReady({
      preflight: async () => {
        calls += 1;
        if (calls === 1) {
          return { ok: false, code: 'TRADE_APPROVAL_REQUIRED', error: 'Approve first.' };
        }
        throw new TradePreflightError(
          'TRADE_PREFLIGHT_UNAVAILABLE',
          'Site unavailable.',
        );
      },
      approve: async () => {},
    }),
    error => error.code === 'TRADE_PREFLIGHT_UNAVAILABLE',
  );
  assert.equal(calls, 2);
});

test('listing orchestration rejects a Site response for a different deployment', async () => {
  await assert.rejects(
    () => ensureTradeListingReady({
      preflight: async () => ({
        ok: true,
        code: 'TRADE_LISTING_PREFLIGHT_OK',
        chainId: 56,
        marketAddr: '0x9999999999999999999999999999999999999999',
        chipAddr: INPUT.chipAddr,
        seller: INPUT.seller,
        creatorAddr: '0x3333333333333333333333333333333333333333',
      }),
      approve: async () => assert.fail('must not approve'),
      expected: {
        chainId: 56,
        marketAddr: '0x4444444444444444444444444444444444444444',
        chipAddr: INPUT.chipAddr,
        seller: INPUT.seller,
      },
    }),
    error => error.code === 'TRADE_DEPLOYMENT_MISMATCH',
  );
});

test('creator verification returns the chain value only when it matches Site', async () => {
  const chainCreator = await verifyTradeListingCreator({
    siteCreatorAddr: '0x3333333333333333333333333333333333333333',
    readCreator: async () => '0x3333333333333333333333333333333333333333',
  });
  assert.equal(chainCreator, '0x3333333333333333333333333333333333333333');
});

test('creator verification rejects a royalty route that differs from chain state', async () => {
  await assert.rejects(
    () => verifyTradeListingCreator({
      siteCreatorAddr: '0x3333333333333333333333333333333333333333',
      readCreator: async () => '0x9999999999999999999999999999999999999999',
    }),
    error => error.code === 'TRADE_CREATOR_MISMATCH',
  );
});

test('creator verification fails closed when chain state cannot be read', async () => {
  await assert.rejects(
    () => verifyTradeListingCreator({
      siteCreatorAddr: '0x3333333333333333333333333333333333333333',
      readCreator: async () => { throw new Error('RPC down'); },
    }),
    error => error.code === 'TRADE_CREATOR_VERIFICATION_FAILED',
  );
});
