import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyResumeAction,
  validateTaskApproval,
} from '../src/task-state.js';
import { ACTION_INTENT_SCHEMA_HASH, buildAcquireExecutionPlan } from '../src/action-intent-contracts.js';
import { authorizeBroadcastAttempt, refreshQueryOnlyTask } from '../src/commands/task.js';

test('broadcasting or later is query-only and can never call writeContract again', () => {
  for (const status of ['broadcasting', 'broadcast', 'result_unknown', 'confirmed', 'failed']) {
    assert.equal(classifyResumeAction({ status, txHash: null }), 'query_only');
  }
  assert.equal(classifyResumeAction({ status: 'awaiting_approval' }), 'approval_required');
  assert.equal(classifyResumeAction({ status: 'approved' }), 'preflight_then_broadcast');
});

test('query-only recovery reports a locally saved transaction hash before rechecking chain state', async () => {
  const calls = [];
  const txHash = `0x${'1'.repeat(64)}`;
  const client = {
    async recordBroadcast(id, hash) {
      calls.push(['recordBroadcast', id, hash]);
      return { intent: { id, status: 'broadcast', txHash: hash } };
    },
    async recheck(id) {
      calls.push(['recheck', id]);
      return { intent: { id, status: 'confirmed', txHash } };
    },
  };

  const result = await refreshQueryOnlyTask(
    { id: '123e4567-e89b-42d3-a456-426614174000', status: 'broadcasting', txHash: null },
    client,
    { txHash },
  );

  assert.equal(result.status, 'confirmed');
  assert.deepEqual(calls, [
    ['recordBroadcast', '123e4567-e89b-42d3-a456-426614174000', txHash],
    ['recheck', '123e4567-e89b-42d3-a456-426614174000'],
  ]);
});

test('approval is exact-plan, explicit, and rejects changed or expired plans', () => {
  const planHash = 'a'.repeat(64);
  assert.deepEqual(validateTaskApproval({
    yes: true,
    currentPlanHash: planHash,
    approvedPlanHash: planHash,
    executeBy: '2099-01-01T00:00:00.000Z',
    now: new Date('2026-08-04T12:00:00.000Z'),
  }), { ok: true, planHash });

  for (const input of [
    { yes: false, currentPlanHash: planHash, approvedPlanHash: planHash, executeBy: '2099-01-01T00:00:00.000Z' },
    { yes: true, currentPlanHash: planHash, approvedPlanHash: 'b'.repeat(64), executeBy: '2099-01-01T00:00:00.000Z' },
    { yes: true, currentPlanHash: planHash, approvedPlanHash: planHash, executeBy: '2020-01-01T00:00:00.000Z' },
  ]) {
    assert.throws(() => validateTaskApproval({ ...input, now: new Date('2026-08-04T12:00:00.000Z') }));
  }
});

test('execution plan binds the canonical ERC token standard', () => {
  const intent = {
    kind: 'skill.acquire.v1',
    schemaHash: ACTION_INTENT_SCHEMA_HASH,
    walletAddr: '0x1111111111111111111111111111111111111111',
    skillSlug: 'example-finchip',
    chainId: 56,
    contractAddr: '0x2222222222222222222222222222222222222222',
    tokenStandard: 'ERC-721',
    maxPriceWei: '10',
    maxGasFeeWei: '2',
  };
  const preview = {
    wallet: intent.walletAddr,
    slug: intent.skillSlug,
    chainId: intent.chainId,
    contractAddr: intent.contractAddr,
    tokenStandard: 'ERC-721',
    priceWei: '10',
    estimatedMaxGasFeeWei: '2',
  };
  const plan = buildAcquireExecutionPlan(preview, intent, new Date('2026-08-04T12:00:00.000Z'));
  assert.equal(plan.tokenStandard, 'ERC-721');
  assert.throws(() => buildAcquireExecutionPlan({ ...preview, tokenStandard: 'ERC-1155' }, intent));
});

test('lost broadcast-attempt response authorizes only the same persisted attempt', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const planHash = 'a'.repeat(64);
  const broadcastAttemptId = '223e4567-e89b-42d3-a456-426614174000';
  const calls = [];
  const networkError = Object.assign(new Error('response lost'), { code: 'AUTH_NETWORK_ERROR', exitCode: 5 });
  const client = {
    async beginBroadcast(...args) { calls.push(['beginBroadcast', ...args]); throw networkError; },
    async show(id) {
      calls.push(['show', id]);
      return { intent: { id, status: 'broadcasting', planHash, approvedPlanHash: planHash, broadcastAttemptId } };
    },
  };

  const intent = await authorizeBroadcastAttempt(client, { taskId, planHash, broadcastAttemptId });
  assert.equal(intent.broadcastAttemptId, broadcastAttemptId);
  assert.deepEqual(calls, [
    ['beginBroadcast', taskId, planHash, broadcastAttemptId],
    ['show', taskId],
  ]);
});

test('rate limit before transition never authorizes wallet execution', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const planHash = 'a'.repeat(64);
  const broadcastAttemptId = '223e4567-e89b-42d3-a456-426614174000';
  const rateLimited = Object.assign(new Error('limited'), { code: 'RATE_LIMITED', exitCode: 3 });
  const client = {
    async beginBroadcast() { throw rateLimited; },
    async show() { return { intent: { id: taskId, status: 'approved', planHash, broadcastAttemptId: null } }; },
  };
  await assert.rejects(
    authorizeBroadcastAttempt(client, { taskId, planHash, broadcastAttemptId }),
    error => error === rateLimited,
  );
});

test('another broadcast attempt cannot borrow a broadcasting state', async () => {
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  const planHash = 'a'.repeat(64);
  const broadcastAttemptId = '223e4567-e89b-42d3-a456-426614174000';
  const networkError = Object.assign(new Error('response lost'), { code: 'AUTH_NETWORK_ERROR', exitCode: 5 });
  const client = {
    async beginBroadcast() { throw networkError; },
    async show() {
      return { intent: {
        id: taskId,
        status: 'broadcasting',
        planHash,
        approvedPlanHash: planHash,
        broadcastAttemptId: '323e4567-e89b-42d3-a456-426614174000',
      } };
    },
  };
  await assert.rejects(
    authorizeBroadcastAttempt(client, { taskId, planHash, broadcastAttemptId }),
    error => error.code === 'INTENT_STATE_CONFLICT',
  );
});
