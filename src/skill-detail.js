import { getAddress, isAddress } from 'viem';
import { normalizeApiOrigin } from './auth-client.js';
import { resolveChain } from './chains.js';
import { siteLookupSlug } from './skill-slug.js';
import { CliError } from './utils.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export class SkillDetailError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'SkillDetailError';
  }
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nullable(value) {
  return value == null ? null : value;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = numberOrNull(value);
  return parsed != null && parsed >= 0 ? parsed : fallback;
}

function displayText(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed) return trimmed;
  return typeof fallback === 'string' ? fallback.trim() : '';
}

export function parsePublicDeploymentOptions(options = {}) {
  if (Boolean(options.chain) !== Boolean(options.addr)) {
    throw new SkillDetailError(
      'SKILL_SHOW_INVALID',
      '--chain and --addr must be provided together.',
      3
    );
  }
  if (!options.addr) return null;
  if (!isAddress(options.addr, { strict: false })) {
    throw new SkillDetailError('SKILL_SHOW_INVALID', 'Invalid deployment contract address.', 3);
  }
  let chain;
  try {
    chain = resolveChain(options.chain);
  } catch {
    throw new SkillDetailError('SKILL_SHOW_INVALID', `Unsupported deployment chain: ${options.chain}.`, 3);
  }
  return { chainId: chain.id, contractAddr: getAddress(options.addr.toLowerCase()) };
}

function mapPublicDetail(requestedSlug, payload) {
  const skill = payload.skill;
  const v2 = payload.v2;
  const displayOverrides = objectOrEmpty(skill.display_overrides);
  const chainId = Number.isInteger(skill.chain_id) ? skill.chain_id : null;
  const contractAddr = isAddress(skill.chip_address || '', { strict: false })
    ? getAddress(String(skill.chip_address).toLowerCase())
    : null;
  const acquirable = Boolean(
    skill.source === 'web3'
      && skill.is_on_chain
      && chainId != null
      && contractAddr
  );

  return {
    requestedSlug,
    canonicalSlug: siteLookupSlug(skill.slug),
    skill: {
      id: nullable(skill.id),
      title: nullable(skill.title),
      summary: displayText(displayOverrides.summary, skill.summary),
      description: displayText(displayOverrides.description, skill.description),
      author: nullable(skill.author_name),
      version: nullable(skill.version),
      license: nullable(skill.license),
      category: displayText(displayOverrides.category, skill.category),
      tags: Array.isArray(skill.tags) ? skill.tags : [],
      source: nullable(skill.source),
      curated: Boolean(skill.is_curated),
      stars: nonNegativeNumber(skill.stars),
      downloads: nonNegativeNumber(skill.downloads),
    },
    deployment: {
      acquirable,
      chainId,
      contractAddr,
      // This is a Site display value. Acquire always reads exact wei on-chain.
      price: numberOrNull(skill.chip_price),
      installCount: nonNegativeNumber(skill.install_count),
      encrypted: Boolean(skill.is_encrypted),
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
    rating: objectOrEmpty(v2.rating),
    weeklyStats: objectOrEmpty(v2.weeklyStats),
    reviews: Array.isArray(v2.reviews) ? v2.reviews : [],
    supportedAgents: Array.isArray(v2.supportedAgents) ? v2.supportedAgents : [],
    references: Array.isArray(v2.references) ? v2.references : [],
    relatedSkills: Array.isArray(v2.relatedSkills) ? v2.relatedSkills : [],
    benchmark: objectOrEmpty(v2.benchmark),
    postRewards: {
      available: Boolean(v2.postRewardsAvailable),
      campaign: v2.postRewardCampaign ?? null,
    },
    viewer: null,
  };
}

function validPayload(payload) {
  return payload
    && typeof payload === 'object'
    && payload.skill
    && typeof payload.skill === 'object'
    && !Array.isArray(payload.skill)
    && typeof payload.skill.slug === 'string'
    && payload.skill.slug.length > 0
    && payload.v2
    && typeof payload.v2 === 'object'
    && !Array.isArray(payload.v2);
}

export class SkillDetailClient {
  constructor(options = {}) {
    this.origin = normalizeApiOrigin(options.origin);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async get(rawSlug, options = {}) {
    const requestedSlug = String(rawSlug ?? '').trim();
    if (!requestedSlug || requestedSlug.length > 160) {
      throw new SkillDetailError(
        'SKILL_SHOW_INVALID',
        'Skill slug must contain 1 to 160 characters.',
        3
      );
    }
    const lookupSlug = siteLookupSlug(requestedSlug);
    const requestedDeployment = parsePublicDeploymentOptions(options);
    const url = new URL(`/api/v2/skills/${encodeURIComponent(lookupSlug)}`, `${this.origin}/`);
    if (requestedDeployment) {
      url.searchParams.set('addr', requestedDeployment.contractAddr);
      url.searchParams.set('chainId', String(requestedDeployment.chainId));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let text;
    try {
      // `skill show` is intentionally anonymous. Identity-bearing headers are
      // omitted so results never depend on the machine's local login state.
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: new Headers({ Accept: 'application/json' }),
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new SkillDetailError(
        'SKILL_DETAIL_UNAVAILABLE',
        error?.name === 'AbortError'
          ? 'FinChip Skill detail timed out.'
          : 'Unable to reach FinChip Skill detail.',
        5
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      throw new SkillDetailError('SKILL_NOT_FOUND', `Skill not found: ${requestedSlug}.`, 3);
    }
    if (response.status >= 500) {
      throw new SkillDetailError(
        'SKILL_DETAIL_UNAVAILABLE',
        'FinChip Skill detail is temporarily unavailable.',
        5
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SkillDetailError('SKILL_DETAIL_FAILED', 'FinChip Skill detail refused an unexpected redirect.', 5);
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new SkillDetailError('SKILL_DETAIL_FAILED', 'FinChip Skill detail returned invalid JSON.', 5);
    }
    if (!response.ok) {
      throw new SkillDetailError(
        'SKILL_DETAIL_FAILED',
        `FinChip Skill detail failed with status ${response.status}.`,
        5
      );
    }
    if (!validPayload(payload)) {
      throw new SkillDetailError('SKILL_DETAIL_FAILED', 'FinChip Skill detail returned an invalid response.', 5);
    }

    const detail = mapPublicDetail(requestedSlug, payload);
    if (requestedDeployment) {
      const actualAddr = detail.deployment.contractAddr?.toLowerCase();
      if (
        detail.deployment.chainId !== requestedDeployment.chainId
        || actualAddr !== requestedDeployment.contractAddr.toLowerCase()
      ) {
        throw new SkillDetailError(
          'SKILL_DEPLOYMENT_MISMATCH',
          'Site did not return the exact requested Skill deployment.',
          3,
          {
            requestedChainId: requestedDeployment.chainId,
            requestedContractAddr: requestedDeployment.contractAddr,
            actualChainId: detail.deployment.chainId,
            actualContractAddr: detail.deployment.contractAddr,
          }
        );
      }
    }
    return detail;
  }
}
