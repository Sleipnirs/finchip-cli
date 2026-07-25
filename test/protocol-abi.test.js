import assert from 'node:assert/strict';
import test from 'node:test';
import { FACTORY_ABI } from '../src/protocol.js';

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
