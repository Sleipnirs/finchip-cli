import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { FACTORY_ABI } from '../src/protocol.js';
import { resolveDeployedChip } from '../src/publish-recovery.js';

const FACTORY = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_FACTORY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CREATOR = '0xcccccccccccccccccccccccccccccccccccccccc';
const OTHER_CREATOR = '0xdddddddddddddddddddddddddddddddddddddddd';
const CHIP_A = '0x1111111111111111111111111111111111111111';
const CHIP_B = '0x2222222222222222222222222222222222222222';
const EVENT_ABI = [FACTORY_ABI.find(item => item.type === 'event' && item.name === 'ChipDeployedV2')];

function deploymentLog({
  factory = FACTORY,
  chip = CHIP_A,
  creator = CREATOR,
  slug = 'demo_finchip',
  feeModel = 0,
  price = 10n,
} = {}) {
  return {
    address: factory,
    topics: encodeEventTopics({
      abi: EVENT_ABI,
      eventName: 'ChipDeployedV2',
      args: { chipContract: chip, creator },
    }),
    data: encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint8' }, { type: 'uint256' }],
      [slug, feeModel, price],
    ),
  };
}

test('a single Factory deployment log is accepted with mismatch warnings', () => {
  const result = resolveDeployedChip({
    receipt: { logs: [deploymentLog({ creator: OTHER_CREATOR, slug: 'unexpected_finchip' })] },
    factory: FACTORY,
    creator: CREATOR,
    slug: 'demo_finchip',
  });

  assert.equal(result.contractAddr, CHIP_A);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.warnings.length, 2);
});

test('creator and slug disambiguate multiple Factory deployment logs', () => {
  const result = resolveDeployedChip({
    receipt: {
      logs: [
        deploymentLog({ chip: CHIP_A, creator: OTHER_CREATOR, slug: 'other_finchip' }),
        deploymentLog({ chip: CHIP_B }),
        deploymentLog({ factory: OTHER_FACTORY, chip: CHIP_A }),
      ],
    },
    factory: FACTORY,
    creator: CREATOR,
    slug: 'demo_finchip',
  });

  assert.equal(result.contractAddr, CHIP_B);
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.warnings, []);
});

test('ambiguous multiple Factory deployment logs do not guess a contract', () => {
  const result = resolveDeployedChip({
    receipt: {
      logs: [
        deploymentLog({ chip: CHIP_A, creator: OTHER_CREATOR, slug: 'other-a_finchip' }),
        deploymentLog({ chip: CHIP_B, creator: OTHER_CREATOR, slug: 'other-b_finchip' }),
      ],
    },
    factory: FACTORY,
    creator: CREATOR,
    slug: 'demo_finchip',
  });

  assert.equal(result.contractAddr, null);
  assert.equal(result.candidateCount, 2);
  assert.match(result.warnings[0], /ambiguous/i);
});
