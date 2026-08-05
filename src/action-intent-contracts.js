import { createHash } from 'node:crypto';
import { CliError } from './utils.js';

export const ACTION_INTENT_SCHEMA_VERSION = 'finchip-action-intent-v1';

export function canonicalizeJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`).join(',')}}`;
  throw new CliError('TASK_INVALID', 'Unsupported canonical JSON value.', 3);
}

export const ACTION_INTENT_SCHEMA_HASH = createHash('sha256').update(canonicalizeJson({
  additionalProperties: false,
  kind: 'skill.acquire.v1',
  required: ['kind', 'skillSlug', 'chainId', 'maxPriceWei', 'maxGasFeeWei', 'idempotencyKey'],
})).digest('hex');

export function computeExecutionPlanHash(plan) {
  const { planHash: _ignored, ...hashable } = plan;
  return createHash('sha256').update(canonicalizeJson(hashable)).digest('hex');
}

export function buildAcquireExecutionPlan(preview, intent, now = new Date()) {
  if (intent.kind !== 'skill.acquire.v1' || intent.schemaHash !== ACTION_INTENT_SCHEMA_HASH) {
    throw new CliError('CLIENT_VERSION_UNSUPPORTED', 'Action Intent schema is not supported by this CLI.', 3);
  }
  if (
    preview.wallet?.toLowerCase() !== intent.walletAddr?.toLowerCase()
    || preview.slug !== intent.skillSlug
    || preview.chainId !== intent.chainId
    || preview.contractAddr?.toLowerCase() !== intent.contractAddr?.toLowerCase()
    || preview.tokenStandard !== intent.tokenStandard
  ) throw new CliError('INTENT_STATE_CONFLICT', 'Acquire preflight does not match the claimed Intent.', 3);
  const plan = {
    version: 'skill.acquire.plan.v1',
    walletAddr: preview.wallet.toLowerCase(),
    skillSlug: preview.slug,
    chainId: preview.chainId,
    contractAddr: preview.contractAddr.toLowerCase(),
    tokenStandard: preview.tokenStandard,
    quantity: 1,
    priceWei: String(preview.priceWei),
    maxPriceWei: String(intent.maxPriceWei),
    estimatedMaxGasFeeWei: String(preview.estimatedMaxGasFeeWei),
    maxGasFeeWei: String(intent.maxGasFeeWei),
    maxTotalWei: (BigInt(preview.priceWei) + BigInt(preview.estimatedMaxGasFeeWei)).toString(),
    simulation: 'success',
    preparedAt: now.toISOString(),
  };
  return { ...plan, planHash: computeExecutionPlanHash(plan) };
}
