import { normalizeApiOrigin } from './auth-client.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class TradePreflightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TradePreflightError';
    this.code = code;
    this.details = details;
  }
}

function unavailable() {
  return new TradePreflightError(
    'TRADE_PREFLIGHT_UNAVAILABLE',
    'Listing preflight is temporarily unavailable. Nothing was submitted.',
  );
}

function isStableResponse(value) {
  return value
    && typeof value === 'object'
    && typeof value.ok === 'boolean'
    && typeof value.code === 'string';
}

export class TradePreflightPublicClient {
  constructor(options = {}) {
    this.origin = normalizeApiOrigin(options.origin);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async preflight(input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.origin}/api/v2/trade/listings/preflight`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        },
      );
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) throw unavailable();
      const body = await response.json().catch(() => null);
      if (response.status >= 500 || !isStableResponse(body)) throw unavailable();
      return body;
    } catch (error) {
      if (error instanceof TradePreflightError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

function resultError(result) {
  const code = typeof result?.code === 'string' ? result.code : 'TRADE_PREFLIGHT_UNAVAILABLE';
  const message = typeof result?.error === 'string' && result.error.trim()
    ? result.error.trim()
    : 'Listing preflight failed. Nothing was submitted.';
  return new TradePreflightError(code, message, result || {});
}

function requireContext(result, expected) {
  if (!expected) return;
  const mismatched = [
    ['chainId', (a, b) => Number(a) === Number(b)],
    ['marketAddr', (a, b) => String(a).toLowerCase() === String(b).toLowerCase()],
    ['chipAddr', (a, b) => String(a).toLowerCase() === String(b).toLowerCase()],
    ['seller', (a, b) => String(a).toLowerCase() === String(b).toLowerCase()],
  ].some(([field, matches]) => !matches(result?.[field], expected[field]));
  if (mismatched) {
    throw new TradePreflightError(
      'TRADE_DEPLOYMENT_MISMATCH',
      'Site preflight returned a different chain, Market, Chip, or seller.',
      result || {},
    );
  }
}

function requireReadyResult(result, expected) {
  requireContext(result, expected);
  if (!result?.ok) throw resultError(result);
  if (!ADDRESS_RE.test(result.creatorAddr || '')) throw unavailable();
  return result;
}

export async function ensureTradeListingReady({ preflight, approve, expected }) {
  const initial = await preflight();
  requireContext(initial, expected);
  if (initial?.ok) return requireReadyResult(initial, expected);
  if (initial?.code !== 'TRADE_APPROVAL_REQUIRED') throw resultError(initial);

  await approve();
  return requireReadyResult(await preflight(), expected);
}
