import assert from 'node:assert/strict';
import test from 'node:test';
import { CHIP_ABI, CHIP_721_ABI, FACTORY_ABI } from '../src/protocol.js';

function entry(type, name) {
  const item = FACTORY_ABI.find(candidate => candidate.type === type && candidate.name === name);
  assert.ok(item, `${type} ${name} must exist`);
  return item;
}

test('Factory ABI matches the production deploy functions and events', () => {
  const deployTypes = [
    'string', 'string', 'string', 'bytes32', 'string', 'string', 'string',
    'uint8', 'uint256', 'uint256', 'uint96', 'string', 'uint256',
  ];

  assert.deepEqual(entry('function', 'deployChip').inputs.map(input => input.type), deployTypes);
  assert.deepEqual(entry('function', 'deployChip721').inputs.map(input => input.type), deployTypes);
  assert.deepEqual(
    entry('event', 'ChipDeployedV2').inputs.map(input => input.type),
    ['address', 'address', 'string', 'uint8', 'uint256'],
  );
  assert.deepEqual(
    entry('event', 'ChipDeployedV2_721').inputs.map(input => input.type),
    ['address', 'address', 'string', 'uint8', 'uint256'],
  );
});

test('Chip ABI reads the complete on-chain encryption tuple', () => {
  const getLitData = CHIP_ABI.find(item => item.type === 'function' && item.name === 'getLitData');
  assert.ok(getLitData);
  assert.deepEqual(getLitData.outputs.map(output => output.type), ['string', 'string', 'string']);
});

test('both Chip ABIs expose on-chain source manifest getters for verified downloads', () => {
  for (const abi of [CHIP_ABI, CHIP_721_ABI]) {
    const contentHash = abi.find(item => item.type === 'function' && item.name === 'contentHash');
    const sourceUrl = abi.find(item => item.type === 'function' && item.name === 'sourceUrl');
    assert.deepEqual(contentHash?.outputs?.map(output => output.type), ['bytes32']);
    assert.deepEqual(sourceUrl?.outputs?.map(output => output.type), ['string']);
  }
});
