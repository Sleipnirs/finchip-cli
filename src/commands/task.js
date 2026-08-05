import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, resolveWalletPrivateKey } from '../config.js';
import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { ActionIntentClient } from '../action-intent-client.js';
import { buildAcquireExecutionPlan } from '../action-intent-contracts.js';
import { prepareAcquirePlan, executeAcquireWithWriteContract } from './acquire.js';
import { runLocalConfirmation } from '../localhost-confirmation.js';
import { assertSameFinchipOrigin, parseFinchipTaskUrl } from '../site-origin.js';
import { listTaskRecords, loadTaskRecord, saveTaskRecord } from '../task-records.js';
import { emitFailure, emitResult, hd, inf, ok, sep, wrn } from '../utils.js';

const CLI_VERSION = '0.5.2';
const QUERY_ONLY_STATUSES = new Set(['broadcasting', 'broadcast', 'result_unknown', 'confirmed', 'failed', 'denied', 'cancelled', 'expired']);
const AMBIGUOUS_BROADCAST_ERRORS = new Set([
  'RATE_LIMITED',
  'RATE_LIMIT_UNAVAILABLE',
  'AUTH_NETWORK_ERROR',
  'TASK_STATE_UNAVAILABLE',
  'TASK_REQUEST_FAILED',
]);

function selectedWallet() {
  const config = loadConfig();
  const account = privateKeyToAccount(resolveWalletPrivateKey(config));
  return { config, account, walletAddr: account.address.toLowerCase() };
}

function taskError(response, payload) {
  const code = payload?.code || (response.status === 404 ? 'NOT_FOUND' : 'TASK_REQUEST_FAILED');
  return new FinchipAuthError(code, payload?.error || `FinChip Task request failed with status ${response.status}.`, response.status >= 500 ? 5 : 3);
}

async function loginTask(parsed, dependencies = {}) {
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  const { account, walletAddr, config } = selectedWallet();
  const claimed = await auth.json(`/api/auth/cli-login/requests/${parsed.taskId}/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimSecret: parsed.claimSecret, walletAddr, cliVersion: CLI_VERSION }),
  });
  if (!claimed.response.ok) throw taskError(claimed.response, claimed.payload);
  const result = await runLocalConfirmation({
    origin: auth.origin,
    walletAddr,
    purpose: 'Sign in to the browser and CLI with this Agent wallet',
    openBrowser: dependencies.openBrowser,
    onConfirm: async () => {
      const signature = await account.signMessage({ message: claimed.payload.message });
      const authorized = await auth.json(`/api/auth/cli-login/requests/${parsed.taskId}/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddr, message: claimed.payload.message, signature, signatureChainId: Number(config.chain) || 56 }),
      });
      if (!authorized.response.ok) throw taskError(authorized.response, authorized.payload);
      auth.persistCredentials();
      const handoff = assertSameFinchipOrigin(authorized.payload.handoffUrl);
      return { ...authorized.payload, redirectUrl: handoff.toString() };
    },
  });
  const session = await auth.getSession();
  if (!session.authenticated
    || session.authMode !== 'agent_cli'
    || session.account?.clientKind !== 'cli'
    || session.account?.authMode !== 'agent_cli'
    || session.wallet?.clientKind !== 'cli'
    || session.wallet?.authMode !== 'agent_cli'
    || session.wallet?.walletAddr?.toLowerCase() !== walletAddr) {
    auth.clearCredentials();
    throw new FinchipAuthError('AUTH_SESSION_INVALID', 'FinChip did not create the expected wallet-bound CLI session.', 3);
  }
  return { ok: true, code: 'AUTHENTICATED', taskId: parsed.taskId, origin: auth.origin, walletAddr, userId: result.userId };
}

async function preflightIntent(intent, dependencies = {}) {
  const prepared = await prepareAcquirePlan({
    slug: intent.skillSlug,
    chain: String(intent.chainId),
    maxPriceWei: intent.maxPriceWei,
    maxGasFeeWei: intent.maxGasFeeWei,
    dryRun: true,
  }, dependencies.acquireDependencies);
  return { prepared, plan: buildAcquireExecutionPlan(prepared.preview, intent) };
}

async function claimActionTask(parsed, dependencies = {}) {
  return claimActionTaskById(parsed.taskId, parsed.claimSecret, dependencies);
}

export async function claimActionTaskById(taskId, claimSecret = null, dependencies = {}) {
  const { walletAddr } = (dependencies.selectedWallet || selectedWallet)();
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  const client = dependencies.actionClient || new ActionIntentClient({ authClient: auth, cliVersion: CLI_VERSION });
  await client.ensureCliSession(walletAddr);
  await client.assertCompatible();
  const { intent } = await client.claim(taskId, claimSecret);
  const { plan } = await preflightIntent(intent, dependencies);
  const updated = await client.putPlan(intent.id, plan);
  saveTaskRecord({ taskId: intent.id, kind: intent.kind, origin: auth.origin, walletAddr, status: updated.intent.status, planHash: plan.planHash, plan, broadcastAttempted: false });
  return { ok: true, code: 'TASK_AWAITING_APPROVAL', taskId: intent.id, status: updated.intent.status, plan };
}

export async function refreshQueryOnlyTask(intent, client, record = loadTaskRecord(intent.id)) {
  let current = intent;
  if (current.status === 'broadcasting' && record?.txHash) {
    const recorded = await client.recordBroadcast(current.id, record.txHash);
    current = recorded.intent ?? current;
  }
  if (['broadcasting', 'broadcast', 'result_unknown'].includes(current.status)) {
    const checked = await client.recheck(current.id);
    current = checked.intent ?? current;
  }
  return current;
}

function isExactBroadcastAuthorization(intent, expected) {
  return intent?.status === 'broadcasting'
    && intent.planHash === expected.planHash
    && intent.approvedPlanHash === expected.planHash
    && intent.broadcastAttemptId === expected.broadcastAttemptId;
}

export async function authorizeBroadcastAttempt(client, expected) {
  try {
    const authorized = await client.beginBroadcast(expected.taskId, expected.planHash, expected.broadcastAttemptId);
    if (!isExactBroadcastAuthorization(authorized?.intent, expected)) {
      throw new FinchipAuthError('INTENT_STATE_CONFLICT', 'Site did not authorize this exact broadcast attempt.', 3, { retrySafe: false });
    }
    return authorized.intent;
  } catch (error) {
    if (!AMBIGUOUS_BROADCAST_ERRORS.has(error?.code) && error?.exitCode !== 5) throw error;
    let shown;
    try { shown = await client.show(expected.taskId); } catch { throw error; }
    if (isExactBroadcastAuthorization(shown?.intent, expected)) return shown.intent;
    if (shown?.intent?.status === 'broadcasting') {
      throw new FinchipAuthError('INTENT_STATE_CONFLICT', 'Another process owns the recorded broadcast attempt.', 3, { retrySafe: false });
    }
    throw error;
  }
}

async function runParsedTask(parsed, options = {}, dependencies = {}) {
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  try {
    return await loginTask(parsed, { ...dependencies, authClient: auth });
  } catch (error) {
    if (error?.code !== 'NOT_FOUND') throw error;
  }
  return claimActionTask(parsed, { ...dependencies, authClient: auth });
}

export async function resumeTask(taskId, options = {}, dependencies = {}) {
  const { walletAddr } = (dependencies.selectedWallet || selectedWallet)();
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  const client = dependencies.actionClient || new ActionIntentClient({ authClient: auth, cliVersion: CLI_VERSION });
  await client.ensureCliSession(walletAddr);
  await client.assertCompatible();
  const shown = await client.show(taskId);
  let intent = shown.intent;
  if (QUERY_ONLY_STATUSES.has(intent.status)) {
    intent = await refreshQueryOnlyTask(intent, client);
    return { ok: true, code: 'TASK_QUERY_ONLY', taskId, status: intent.status, txHash: intent.txHash ?? null, retrySafe: false };
  }
  if (!['awaiting_approval', 'approved'].includes(intent.status)) throw new FinchipAuthError('INTENT_STATE_CONFLICT', `Task cannot resume from ${intent.status}.`, 3);
  const record = loadTaskRecord(taskId);
  const preparedResult = await preflightIntent(intent, dependencies);
  const stableTime = intent.planSummary?.preparedAt ? new Date(intent.planSummary.preparedAt) : new Date();
  const currentPlan = buildAcquireExecutionPlan(preparedResult.prepared.preview, intent, stableTime);
  if (!record || currentPlan.planHash !== intent.planHash || record.planHash !== intent.planHash) {
    const replacedPlan = buildAcquireExecutionPlan(preparedResult.prepared.preview, intent);
    const updated = await client.putPlan(taskId, replacedPlan);
    saveTaskRecord({ taskId, kind: intent.kind, origin: auth.origin, walletAddr, status: updated.intent.status, planHash: replacedPlan.planHash, plan: replacedPlan, broadcastAttempted: false });
    return { ok: true, code: 'TASK_PLAN_CHANGED', taskId, status: updated.intent.status, plan: replacedPlan, confirmationRequired: true };
  }
  if (!options.yes) return { ok: true, code: 'TASK_CONFIRM_REQUIRED', taskId, status: intent.status, plan: currentPlan, confirmationRequired: true };
  if (intent.status === 'awaiting_approval') await client.decide(taskId, 'approve', currentPlan.planHash);
  const broadcastAttemptId = randomUUID();
  const pendingBroadcastRecord = saveTaskRecord({ ...record, broadcastAttemptId, broadcastAttempted: false });
  await authorizeBroadcastAttempt(client, { taskId, planHash: currentPlan.planHash, broadcastAttemptId });
  const broadcastingRecord = saveTaskRecord({ ...pendingBroadcastRecord, status: 'broadcasting', broadcastAttempted: true });
  try {
    const result = await executeAcquireWithWriteContract(preparedResult.prepared, {
      onTxHash: async txHash => {
        saveTaskRecord({ ...broadcastingRecord, status: 'broadcast', txHash });
        await client.recordBroadcast(taskId, txHash);
      },
    });
    await client.recheck(taskId);
    return { ok: true, code: 'TASK_BROADCAST', taskId, status: 'broadcast', txHash: result.txHash, planHash: currentPlan.planHash };
  } catch (error) {
    if (['ACQUIRE_RESULT_UNKNOWN', 'ACQUIRE_TX_FAILED', 'ACQUIRE_VERIFY_FAILED'].includes(error?.code)) {
      const txHash = error.details?.txHash || loadTaskRecord(taskId)?.txHash || null;
      if (error.code === 'ACQUIRE_RESULT_UNKNOWN') await client.resultUnknown(taskId, txHash);
      else if (txHash) await client.recheck(taskId);
      saveTaskRecord({ ...broadcastingRecord, status: error.code === 'ACQUIRE_RESULT_UNKNOWN' ? 'result_unknown' : 'broadcast', txHash });
    }
    throw error;
  }
}

export async function denyTask(taskId, options = {}, dependencies = {}) {
  const record = loadTaskRecord(taskId);
  if (!record?.planHash) throw new FinchipAuthError('INTENT_STATE_CONFLICT', 'This Task has no locally verified execution plan to deny.', 3);
  const client = dependencies.actionClient || new ActionIntentClient({ cliVersion: CLI_VERSION, ...dependencies });
  const denied = await client.deny(taskId, record.planHash, options.reason || 'human_denied');
  saveTaskRecord({ ...record, status: denied.intent.status });
  return { ok: true, code: 'TASK_DENIED', taskId, status: denied.intent.status };
}

export async function listTasks(options = {}, dependencies = {}) {
  const { walletAddr } = (dependencies.selectedWallet || selectedWallet)();
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  const client = dependencies.actionClient || new ActionIntentClient({ authClient: auth, cliVersion: CLI_VERSION });
  await client.ensureCliSession(walletAddr);
  await client.assertCompatible();
  return { ok: true, code: 'TASK_LIST', local: listTaskRecords(), ...(await client.list(options.status)) };
}

export async function showTask(taskId, dependencies = {}) {
  const { walletAddr } = (dependencies.selectedWallet || selectedWallet)();
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  const client = dependencies.actionClient || new ActionIntentClient({ authClient: auth, cliVersion: CLI_VERSION });
  await client.ensureCliSession(walletAddr);
  await client.assertCompatible();
  return { ok: true, code: 'TASK_STATUS', ...(await client.show(taskId)) };
}

function renderTask(result) {
  hd('FinChip Agent Task'); sep(); ok(`${result.code} · ${result.taskId || ''}`); inf(`status: ${result.status || 'complete'}`);
  if (result.plan) {
    inf(`skill: ${result.plan.skillSlug}`); inf(`chain: ${result.plan.chainId}`); inf(`contract: ${result.plan.contractAddr}`);
    inf(`price: ${result.plan.priceWei} wei`); inf(`max gas fee: ${result.plan.estimatedMaxGasFeeWei} wei`); inf(`plan hash: ${result.plan.planHash}`);
  }
  if (result.confirmationRequired) wrn('No transaction was signed. Obtain explicit Human approval, then run task resume with --yes.');
}

async function command(options, operation) { try { const result = await operation(); emitResult(options, result, () => renderTask(result)); } catch (error) { emitFailure(options, error); } }

export async function cmdTaskRun(taskUrl, options = {}) { return command(options, () => runParsedTask(parseFinchipTaskUrl(taskUrl), options)); }
export async function cmdTaskClaim(taskId, options = {}) { return command(options, () => claimActionTaskById(taskId, null)); }
export async function cmdTaskResume(taskId, options = {}) { return command(options, () => resumeTask(taskId, options)); }
export async function cmdTaskDeny(taskId, options = {}) { return command(options, () => denyTask(taskId, options)); }
export async function cmdTaskShow(taskId, options = {}) { return command(options, () => showTask(taskId)); }
export async function cmdTaskList(options = {}) { return command(options, () => listTasks(options)); }

export { loginTask, runParsedTask };
