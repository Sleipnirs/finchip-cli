import test from 'node:test';
import assert from 'node:assert/strict';

import { readChipMarketDetails } from '../src/commands/market.js';

test('market reads ERC-721 chips with fork getters', async () => {
  const calls = [];
  const client = {
    async readContract({ functionName, args }) {
      calls.push({ functionName, args });
      if (functionName === 'supportsInterface') return true;
      if (functionName === 'name') return 'Forkable Agent';
      if (functionName === 'forkPrice') return 25n;
      if (functionName === 'totalForked') return 3n;
      if (functionName === 'maxForks') return 10n;
      if (functionName === 'category') return 'AI Agent';
      throw new Error(`Unexpected getter: ${functionName}`);
    },
  };

  const details = await readChipMarketDetails(
    client,
    '0x1111111111111111111111111111111111111111',
    'forkable-agent',
  );

  assert.equal(details.kind, 'ERC-721');
  assert.equal(details.price, 25n);
  assert.equal(details.totalMinted, 3n);
  assert.equal(details.maxSupply, 10n);
  assert.ok(calls.some(call =>
    call.functionName === 'supportsInterface'
    && call.args?.[0] === '0x80ac58cd'
  ));
  assert.ok(calls.some(call => call.functionName === 'forkPrice'));
  assert.ok(calls.some(call => call.functionName === 'totalForked'));
  assert.ok(calls.some(call => call.functionName === 'maxForks'));
  assert.equal(calls.some(call => call.functionName === 'licensePrice'), false);
});

test('market keeps ERC-1155 getters for non-ERC-721 chips', async () => {
  const calls = [];
  const client = {
    async readContract({ functionName }) {
      calls.push(functionName);
      if (functionName === 'supportsInterface') return false;
      if (functionName === 'name') return 'Licensed Skill';
      if (functionName === 'licensePrice') return 7n;
      if (functionName === 'totalMinted') return 2n;
      if (functionName === 'maxSupply') return 100n;
      if (functionName === 'category') return 'Dev Environment';
      throw new Error(`Unexpected getter: ${functionName}`);
    },
  };

  const details = await readChipMarketDetails(
    client,
    '0x2222222222222222222222222222222222222222',
    'licensed-skill',
  );

  assert.equal(details.kind, 'ERC-1155');
  assert.equal(details.price, 7n);
  assert.ok(calls.includes('licensePrice'));
  assert.equal(calls.includes('forkPrice'), false);
});
