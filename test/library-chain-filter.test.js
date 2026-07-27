import test from 'node:test';
import assert from 'node:assert/strict';

import { chainsForFilter } from '../src/commands/library.js';
import { listChains } from '../src/chains.js';

test('library chain filter accepts configured chain keys', () => {
  assert.deepEqual(chainsForFilter('base').map(chain => chain.id), [8453]);
  assert.deepEqual(chainsForFilter('bsc').map(chain => chain.id), [56]);
});

test('library chain filter accepts numeric chain IDs', () => {
  assert.deepEqual(chainsForFilter('56').map(chain => chain.id), [56]);
});

test('library chain filter scans all chains when omitted', () => {
  assert.equal(chainsForFilter().length, listChains().length);
});

test('library chain filter rejects unknown values', () => {
  assert.throws(() => chainsForFilter('not-a-chain'), /Unsupported chain/i);
});
