import { normalizeApiOrigin } from './auth-client.js';
import { CliError } from './utils.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_OFFSET = 100_000;
const MAX_QUERY_LENGTH = 64;
const SORTS = new Set(['downloads', 'stars', 'rating', 'new']);

export class SkillSearchError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'SkillSearchError';
  }
}

function integerOption(value, fallback, name, min, max) {
  if (value == null) return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new SkillSearchError('SEARCH_INVALID', `${name} must be an integer from ${min} to ${max}.`, 3);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new SkillSearchError('SEARCH_INVALID', `${name} must be an integer from ${min} to ${max}.`, 3);
  }
  return parsed;
}

function nullable(value) {
  return value == null ? null : value;
}

function numeric(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapSkill(skill) {
  return {
    id: nullable(skill.id),
    slug: nullable(skill.slug),
    title: nullable(skill.title),
    summary: nullable(skill.summary),
    author: nullable(skill.author_name),
    version: nullable(skill.version),
    license: nullable(skill.license),
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    category: nullable(skill.category),
    stars: numeric(skill.stars, 0),
    downloads: numeric(skill.downloads, 0),
    rating: numeric(skill.rating),
    reviewCount: numeric(skill.reviewCount, 0),
    curated: Boolean(skill.is_curated),
    source: nullable(skill.source),
    deployment: {
      contractAddr: nullable(skill.chip_address),
      chainId: numeric(skill.chain_id),
      // Site intentionally returns a native-unit number here. Do not recompute
      // it from price_wei: on-chain acquire uses exact bigint math and may differ in
      // the final floating-point digit.
      price: numeric(skill.chip_price),
      installCount: numeric(skill.install_count, 0),
      encryptionMode: nullable(skill.encrypt_mode),
    },
    safety: {
      certik: {
        status: nullable(skill.certik_status),
        verifiedAt: nullable(skill.certik_verified_at),
        reportUrl: nullable(skill.certik_report_url),
      },
      finchip: {
        status: nullable(skill.finchip_safety_status),
        verifiedAt: nullable(skill.finchip_safety_verified_at),
        notes: nullable(skill.finchip_safety_notes),
      },
    },
    postRewards: {
      available: Boolean(skill.postRewardsAvailable),
      count: numeric(skill.availablePosts, 0),
    },
  };
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function validatePayload(payload) {
  return payload
    && typeof payload === 'object'
    && Array.isArray(payload.skills)
    && Number.isInteger(payload.total)
    && payload.total >= 0
    && Number.isInteger(payload.limit)
    && payload.limit >= 1
    && Number.isInteger(payload.offset)
    && payload.offset >= 0;
}

export class SkillSearchClient {
  constructor(options = {}) {
    this.origin = normalizeApiOrigin(options.origin);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(rawQuery, options = {}) {
    const query = String(rawQuery ?? '').trim();
    if (!query || query.length > MAX_QUERY_LENGTH) {
      throw new SkillSearchError(
        'SEARCH_INVALID',
        `Search query must contain 1 to ${MAX_QUERY_LENGTH} characters.`,
        3
      );
    }

    const sort = options.sort == null ? 'downloads' : String(options.sort);
    if (!SORTS.has(sort)) {
      throw new SkillSearchError('SEARCH_INVALID', 'Sort must be downloads, stars, rating, or new.', 3);
    }
    const limit = integerOption(options.limit, DEFAULT_LIMIT, 'limit', 1, MAX_LIMIT);
    const offset = integerOption(options.offset, 0, 'offset', 0, MAX_OFFSET);
    const category = options.category == null ? null : String(options.category);
    if (category != null && !category.trim()) {
      throw new SkillSearchError('SEARCH_INVALID', 'category cannot be empty.', 3);
    }
    const curated = Boolean(options.curated);

    const url = new URL('/api/skills', `${this.origin}/`);
    url.searchParams.set('search', query);
    url.searchParams.set('source', 'web3');
    url.searchParams.set('sort', sort);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    if (category != null) url.searchParams.set('category', category);
    if (curated) url.searchParams.set('curated', '1');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let text;
    try {
      // /api/skills is publicly cached by the CDN. Attaching cookies or
      // authorization would risk cross-user cache pollution, so this request
      // deliberately has no relationship to FinchipAuthClient or its jar.
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        redirect: 'manual',
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new SkillSearchError(
        'SEARCH_SERVICE_UNAVAILABLE',
        error?.name === 'AbortError'
          ? 'FinChip Skill search timed out.'
          : 'Unable to reach FinChip Skill search.',
        5
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = {};
    let payloadInvalid = false;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payloadInvalid = true;
    }

    const upstreamMessage = typeof payload?.error === 'string' ? payload.error : null;
    if (response.status === 400) {
      throw new SkillSearchError('SEARCH_INVALID', upstreamMessage || 'FinChip rejected the search parameters.', 3);
    }
    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
      throw new SkillSearchError(
        'SEARCH_RATE_LIMITED',
        upstreamMessage || 'FinChip Skill search is temporarily rate limited.',
        5,
        retryAfterSeconds == null ? {} : { retryAfterSeconds }
      );
    }
    if (response.status >= 500) {
      throw new SkillSearchError(
        'SEARCH_SERVICE_UNAVAILABLE',
        'FinChip Skill search is temporarily unavailable.',
        5
      );
    }
    if (payloadInvalid) {
      throw new SkillSearchError('SEARCH_FAILED', 'FinChip Skill search returned an invalid response.', 5);
    }
    if (!response.ok) {
      throw new SkillSearchError(
        'SEARCH_FAILED',
        upstreamMessage || `FinChip Skill search failed with status ${response.status}.`,
        5
      );
    }
    if (!validatePayload(payload)) {
      throw new SkillSearchError('SEARCH_FAILED', 'FinChip Skill search returned an invalid response.', 5);
    }

    return {
      query,
      filters: { category, sort, curated, source: 'web3' },
      pagination: {
        total: payload.total,
        limit: payload.limit,
        offset: payload.offset,
      },
      skills: payload.skills.map(mapSkill),
    };
  }
}
