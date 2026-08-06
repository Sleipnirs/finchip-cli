import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyResumeAction,
  validateTaskApproval,
} from '../src/task-state.js';
import { ACTION_INTENT_SCHEMA_HASH, SUPPORTED_ACTION_INTENT_KINDS, buildAcquireExecutionPlan } from '../src/action-intent-contracts.js';
import { ActionIntentClient } from '../src/action-intent-client.js';
import { actionIntentHandler } from '../src/action-intent-handlers.js';
import { authorizeBroadcastAttempt, classifyStepFailure, refreshQueryOnlyTask } from '../src/commands/task.js';

test('wallet-bound Inbox claim omits copied secrets and keeps the exact Task id', async () => {
  const calls = [];
  const authClient = {
    async json(path, options) {
      calls.push({ path, body: JSON.parse(options.body) });
      return { response: { ok: true }, payload: { ok: true } };
    },
  };
  const client = new ActionIntentClient({ authClient, cliVersion: '0.5.2' });
  const taskId = '123e4567-e89b-42d3-a456-426614174000';
  await client.claim(taskId);
  assert.deepEqual(calls, [{
    path: `/api/action-intents/${taskId}/claim`,
    body: { cliVersion: '0.5.2' },
  }]);
});

test('Action Intent commands require an Agent-mode CLI session for the selected wallet', async () => {
  const walletAddr = '0x1111111111111111111111111111111111111111';
  const valid = {
    authenticated: true,
    authMode: 'agent_cli',
    account: { clientKind: 'cli', authMode: 'agent_cli' },
    wallet: { clientKind: 'cli', authMode: 'agent_cli', walletAddr },
  };
  const authClient = {
    hasPersistedCredentials: () => true,
    clearCredentials: () => assert.fail('valid credentials must not be cleared'),
    getSession: async () => valid,
  };
  const client = new ActionIntentClient({ authClient, cliVersion: '0.5.2' });
  assert.equal((await client.ensureCliSession(walletAddr)).authMode, 'agent_cli');

  authClient.getSession = async () => ({ ...valid, authMode: 'browser_wallet' });
  await assert.rejects(
    client.ensureCliSession(walletAddr),
    error => error.code === 'SESSION_REAUTH_REQUIRED',
  );
});

test('Action Intent compatibility enforces the Site floor within the supported major and full action registry', async () => {
  const compatibleConfig = {
    schemaHash: ACTION_INTENT_SCHEMA_HASH,
    supportedActions: [...SUPPORTED_ACTION_INTENT_KINDS],
    minimumCliVersion: '0.6.0',
  };
  const compatible = new ActionIntentClient({ cliVersion: '0.6.0' });
  compatible.config = async () => compatibleConfig;
  assert.equal((await compatible.assertCompatible()).minimumCliVersion, '0.6.0');

  const outdated = new ActionIntentClient({ cliVersion: '0.5.3' });
  outdated.config = async () => compatibleConfig;
  await assert.rejects(
    outdated.assertCompatible(),
    error => error.code === 'CLIENT_VERSION_UNSUPPORTED',
  );

  const newerMinor = new ActionIntentClient({ cliVersion: '0.7.0' });
  newerMinor.config = async () => compatibleConfig;
  assert.equal((await newerMinor.assertCompatible()).minimumCliVersion, '0.6.0');

  const unsupportedMajor = new ActionIntentClient({ cliVersion: '1.0.0' });
  unsupportedMajor.config = async () => compatibleConfig;
  await assert.rejects(
    unsupportedMajor.assertCompatible(),
    error => error.code === 'CLIENT_VERSION_UNSUPPORTED',
  );
});

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

test('acquire Task preflight passes the claimed chain and contract address together', async () => {
  const marker = new Error('deployment lookup reached');
  const intent = {
    kind: 'skill.acquire.v1',
    walletAddr: '0x1111111111111111111111111111111111111111',
    skillSlug: 'example-finchip',
    chainId: 56,
    contractAddr: '0x2222222222222222222222222222222222222222',
    tokenStandard: 'ERC-1155',
    maxPriceWei: '10',
    maxGasFeeWei: '2',
  };
  await assert.rejects(
    actionIntentHandler(intent.kind).prepare(intent, {
      acquireDependencies: {
        detailClient: {
          async get(slug, options) {
            assert.equal(slug, intent.skillSlug);
            assert.deepEqual(options, { chain: '56', addr: intent.contractAddr });
            throw marker;
          },
        },
      },
    }),
    error => error === marker,
  );
});

test('acquire Task reports a broadcast hash for its single chain step', async () => {
  const txHash = `0x${'6'.repeat(64)}`;
  const callbackCalls = [];
  const walletAddr = '0x1111111111111111111111111111111111111111';
  const prepared = {
    dependencies: {
      walletClientFactory() {
        return {
          client: {
            async writeContract() {
              return txHash;
            },
          },
        };
      },
      loadConfig() {
        return { rpc: {} };
      },
    },
    deployment: {
      chain: { id: 56 },
      contractAddr: '0x2222222222222222222222222222222222222222',
    },
    account: { address: walletAddr },
    privateKey: 'unused-by-injected-wallet-client',
    publicClient: {
      async waitForTransactionReceipt() {
        return { status: 'success', blockNumber: 123n };
      },
      async readContract() {
        return 1n;
      },
    },
    preview: {
      wallet: walletAddr,
      slug: 'example-finchip',
      chainId: 56,
      contractAddr: '0x2222222222222222222222222222222222222222',
      estimatedGas: '100',
    },
    simulatedRequest: {},
    heldBefore: 0n,
    plan: {
      abi: [],
      balanceArgs: address => [address],
    },
  };

  const result = await actionIntentHandler('skill.acquire.v1').execute({
    prepared,
    onTxHash(...args) {
      callbackCalls.push(args);
    },
  });

  assert.deepEqual(callbackCalls, [[txHash]]);
  assert.equal(result.txHash, txHash);
});

test('a later Site-step failure never borrows an earlier transaction hash', () => {
  const txHash = `0x${'4'.repeat(64)}`;
  const siteFailure = Object.assign(new Error('sync failed'), { code: 'PRICE_SYNC_FAILED', details: { txHash } });
  assert.deepEqual(classifyStepFailure({
    step: { index: 1, kind: 'site_mutation' },
    broadcast: false,
  }, siteFailure), {
    result: 'failed',
    txHash: null,
    failureCode: 'PRICE_SYNC_FAILED',
    retrySafe: true,
  });

  assert.deepEqual(classifyStepFailure({
    step: { index: 0, kind: 'chain_transaction' },
    broadcast: true,
    txHash,
  }, siteFailure), {
    result: 'result_unknown',
    txHash,
    failureCode: 'PRICE_SYNC_FAILED',
    retrySafe: false,
  });

  assert.deepEqual(classifyStepFailure({
    step: { index: 0, kind: 'chain_transaction' },
    broadcast: true,
    txHash,
  }, Object.assign(new Error('reverted'), { code: 'TASK_TX_FAILED', details: { txHash } })), {
    result: 'failed',
    txHash,
    failureCode: 'TASK_TX_FAILED',
    retrySafe: false,
  });
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
