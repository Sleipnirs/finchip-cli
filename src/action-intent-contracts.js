import { createHash } from 'node:crypto';
import { CliError } from './utils.js';

export const ACTION_INTENT_SCHEMA_VERSION = 'finchip-action-intent-v2';
export const SUPPORTED_ACTION_INTENT_KINDS = [
  'skill.acquire.v1',
  'skill.download.v1',
  'skill.publish.v1',
  'skill.price.set.v1',
  'skill.creator-attest.v1',
  'trade.list.v1',
  'trade.buy.v1',
  'trade.cancel.v1',
];

const PRODUCER_KEYS = {
  'skill.acquire.v1': ['kind', 'skillSlug', 'chainId', 'maxPriceWei', 'maxGasFeeWei', 'idempotencyKey'],
  'skill.download.v1': ['kind', 'skillSlug', 'chainId', 'maxAccessFeeWei', 'maxGasFeeWei', 'idempotencyKey'],
  'skill.publish.v1': ['kind', 'draftId', 'chainId', 'maxTotalValueWei', 'maxGasFeeWei', 'idempotencyKey'],
  'skill.price.set.v1': ['kind', 'skillSlug', 'chainId', 'newPriceWei', 'maxGasFeeWei', 'idempotencyKey'],
  'skill.creator-attest.v1': ['kind', 'skillSlug', 'chainId', 'maxGasFeeWei', 'idempotencyKey'],
  'trade.list.v1': ['kind', 'skillSlug', 'chainId', 'assetKind', 'tokenId', 'quantity', 'pricePerUnitWei', 'maxGasFeeWei', 'idempotencyKey'],
  'trade.buy.v1': ['kind', 'listingId', 'chainId', 'quantity', 'maxUnitPriceWei', 'maxTotalPriceWei', 'maxGasFeeWei', 'idempotencyKey'],
  'trade.cancel.v1': ['kind', 'listingId', 'chainId', 'maxGasFeeWei', 'idempotencyKey'],
};

export function canonicalizeJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
  throw new CliError('TASK_INVALID', 'Unsupported canonical JSON value.', 3);
}

export const ACTION_INTENT_SCHEMA_HASH = createHash('sha256').update(canonicalizeJson({
  version: ACTION_INTENT_SCHEMA_VERSION,
  actions: Object.fromEntries(SUPPORTED_ACTION_INTENT_KINDS.map(kind => [kind, { additionalProperties: false, required: PRODUCER_KEYS[kind] }])),
})).digest('hex');

export function computeExecutionPlanHash(plan) {
  const { planHash: _ignored, ...hashable } = plan;
  return createHash('sha256').update(canonicalizeJson(hashable)).digest('hex');
}

export function buildActionPlanStep(input) {
  const step = {
    index: input.index,
    kind: input.kind,
    action: input.action,
    required: input.required !== false,
    skip: input.skip === true,
    target: String(input.target).toLowerCase(),
    valueWei: String(input.valueWei ?? '0'),
    estimatedMaxGasFeeWei: String(input.estimatedMaxGasFeeWei ?? '0'),
  };
  return { ...step, stepHash: computeExecutionPlanHash(step) };
}

function assertIntentSupported(intent) {
  if (!SUPPORTED_ACTION_INTENT_KINDS.includes(intent.kind) || intent.schemaHash !== ACTION_INTENT_SCHEMA_HASH) {
    throw new CliError('CLIENT_VERSION_UNSUPPORTED', 'Action Intent schema is not supported by this CLI.', 3);
  }
}

export function buildActionExecutionPlan({ intent, walletAddr, skillSlug, contractAddr, tokenStandard, maxValueWei, estimatedMaxGasFeeWei, details, steps, now = new Date() }) {
  assertIntentSupported(intent);
  const plan = {
    version: 'finchip-action-plan-v2',
    kind: intent.kind,
    walletAddr: String(walletAddr).toLowerCase(),
    skillSlug,
    chainId: intent.chainId,
    contractAddr: String(contractAddr).toLowerCase(),
    tokenStandard,
    maxValueWei: String(maxValueWei),
    estimatedMaxGasFeeWei: String(estimatedMaxGasFeeWei),
    maxGasFeeWei: String(intent.maxGasFeeWei),
    maxTotalWei: (BigInt(maxValueWei) + BigInt(estimatedMaxGasFeeWei)).toString(),
    simulation: 'success',
    preparedAt: now.toISOString(),
    details,
    steps: steps.map(buildActionPlanStep),
  };
  return { ...plan, planHash: computeExecutionPlanHash(plan) };
}

export function buildAcquireExecutionPlan(preview, intent, now = new Date()) {
  if (
    preview.wallet?.toLowerCase() !== intent.walletAddr?.toLowerCase()
    || preview.slug !== intent.skillSlug
    || preview.chainId !== intent.chainId
    || preview.contractAddr?.toLowerCase() !== intent.contractAddr?.toLowerCase()
    || preview.tokenStandard !== intent.tokenStandard
  ) throw new CliError('INTENT_STATE_CONFLICT', 'Acquire preflight does not match the claimed Intent.', 3);
  if (BigInt(preview.priceWei) > BigInt(intent.maxPriceWei)) throw new CliError('ACQUIRE_BUDGET_EXCEEDED', 'The current price exceeds the Intent budget.', 3);
  return buildActionExecutionPlan({
    intent,
    walletAddr: preview.wallet,
    skillSlug: preview.slug,
    contractAddr: preview.contractAddr,
    tokenStandard: preview.tokenStandard,
    maxValueWei: intent.maxPriceWei,
    estimatedMaxGasFeeWei: preview.estimatedMaxGasFeeWei,
    details: { priceWei: String(preview.priceWei), quantity: 1 },
    steps: [{
      index: 0,
      kind: 'chain_transaction',
      action: 'skill.acquire',
      target: preview.contractAddr,
      valueWei: String(preview.priceWei),
      estimatedMaxGasFeeWei: String(preview.estimatedMaxGasFeeWei),
    }],
    now,
  });
}
