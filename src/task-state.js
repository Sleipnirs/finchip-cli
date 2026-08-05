import { CliError } from './utils.js';

const QUERY_ONLY = new Set(['broadcasting', 'broadcast', 'result_unknown', 'confirmed', 'failed']);

export function classifyResumeAction(task) {
  if (QUERY_ONLY.has(task?.status)) return 'query_only';
  if (task?.status === 'awaiting_approval') return 'approval_required';
  if (task?.status === 'approved') return 'preflight_then_broadcast';
  if (['pending', 'claimed'].includes(task?.status)) return 'prepare_plan';
  return 'terminal';
}
export function validateTaskApproval({ yes, currentPlanHash, approvedPlanHash, executeBy, now = new Date() }) {
  if (!yes) throw new CliError('ACQUIRE_CONFIRM_REQUIRED', 'Explicit --yes is required for this exact execution plan.', 3);
  if (!/^[a-f0-9]{64}$/.test(String(currentPlanHash)) || currentPlanHash !== approvedPlanHash) {
    throw new CliError('INTENT_STATE_CONFLICT', 'The approved execution plan no longer matches the current plan.', 3);
  }
  const executeByMs = Date.parse(String(executeBy));
  if (!Number.isFinite(executeByMs) || executeByMs <= now.getTime()) {
    throw new CliError('INTENT_EXPIRED', 'The execution plan has expired.', 3);
  }
  return { ok: true, planHash: currentPlanHash };
}
