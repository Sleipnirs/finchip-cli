import { CliError } from './utils.js';

export const FINCHIP_PROD_ORIGIN = 'https://finchip.ai';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAIM_RE = /^[A-Za-z0-9_-]{8,512}$/;

export function assertNoPublicOriginOverride(env = process.env) {
  if (typeof env.FINCHIP_API_URL === 'string' && env.FINCHIP_API_URL.trim()) {
    throw new CliError(
      'UNSUPPORTED_ORIGIN_OVERRIDE',
      'Published FinChip CLI commands only connect to https://finchip.ai; FINCHIP_API_URL is not supported.',
      3,
    );
  }
}
export function parseFinchipTaskUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new CliError('TASK_INVALID', 'Agent Task URL is invalid.', 3);
  }
  if (url.origin !== FINCHIP_PROD_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new CliError('TASK_ORIGIN_MISMATCH', `Agent Task URL must use ${FINCHIP_PROD_ORIGIN}.`, 3);
  }
  const match = /^\/agent-tasks\/([0-9a-f-]+)$/.exec(url.pathname);
  const taskId = match?.[1]?.toLowerCase();
  const claimSecret = new URLSearchParams(url.hash.slice(1)).get('claim') || '';
  if (!taskId || !UUID_RE.test(taskId) || !CLAIM_RE.test(claimSecret) || url.search) {
    throw new CliError('TASK_INVALID', 'Agent Task URL is missing a valid task ID or claim secret.', 3);
  }
  return { origin: FINCHIP_PROD_ORIGIN, taskId, claimSecret };
}

export function assertSameFinchipOrigin(value) {
  const url = new URL(String(value), FINCHIP_PROD_ORIGIN);
  if (url.origin !== FINCHIP_PROD_ORIGIN) {
    throw new CliError('TASK_ORIGIN_MISMATCH', 'FinChip response attempted to change Site origin.', 3);
  }
  return url;
}
