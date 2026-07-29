import { FinchipAuthClient } from './auth-client.js';
import { getPublicClient } from './client.js';
import { CHIP_ABI, CHIP_721_ABI, IFACE_ID } from './protocol.js';
import { SkillDetailClient } from './skill-detail.js';
import { siteLookupSlug } from './skill-slug.js';
import { CliError } from './utils.js';

export class ReviewError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'ReviewError';
  }
}

function integerOption(value, name, minimum, maximum) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw new ReviewError('REVIEW_INVALID', `${name} must be a whole number from ${minimum} to ${maximum}.`, 3);
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ReviewError('REVIEW_INVALID', `${name} must be a whole number from ${minimum} to ${maximum}.`, 3);
  }
  return parsed;
}

function validReviewVideoUrl(value) {
  const clean = String(value ?? '').trim();
  if (!clean) return null;
  if (clean.length > 512) {
    throw new ReviewError(
      'REVIEW_INVALID',
      'Review video URL must be 512 characters or fewer.',
      3,
    );
  }
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw new ReviewError(
      'REVIEW_INVALID',
      'Review video must be a valid HTTPS YouTube or Vimeo URL.',
      3,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ReviewError(
      'REVIEW_INVALID',
      'Review video must be a valid HTTPS YouTube or Vimeo URL.',
      3,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  const youtubeId = host === 'youtu.be' && segments.length === 1
    ? segments[0]
    : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)
      && parsed.pathname === '/watch'
      ? parsed.searchParams.get('v') || ''
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)
        && segments.length === 2
        && ['shorts', 'live', 'embed'].includes(segments[0])
        ? segments[1]
        : ['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)
          && segments.length === 2
          && segments[0] === 'embed'
          ? segments[1]
          : '';
  const vimeoId = ['vimeo.com', 'www.vimeo.com'].includes(host) && segments.length === 1
    ? segments[0]
    : host === 'player.vimeo.com' && segments.length === 2 && segments[0] === 'video'
      ? segments[1]
      : '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId) && !/^\d{1,20}$/.test(vimeoId)) {
    throw new ReviewError(
      'REVIEW_INVALID',
      'Review video must be a valid HTTPS YouTube or Vimeo URL.',
      3,
    );
  }
  return clean;
}

function submitInput(options) {
  if (options.dryRun && options.yes) {
    throw new ReviewError('REVIEW_INVALID', '--dry-run and --yes cannot be used together.', 3);
  }
  const body = String(options.body ?? '').trim();
  if (!body || body.length > 2_000) {
    throw new ReviewError('REVIEW_INVALID', 'Review body must contain 1 to 2000 characters.', 3);
  }
  const videoUrl = validReviewVideoUrl(options.videoUrl);
  return {
    operationalIndependence: integerOption(
      options.operationalIndependence,
      '--operational-independence',
      1,
      5,
    ),
    outputQuality: integerOption(options.outputQuality, '--output-quality', 1, 5),
    modelCompatibility: integerOption(options.modelCompatibility, '--model-compatibility', 1, 5),
    body,
    videoUrl,
  };
}

async function resolveDetail(slug, options, dependencies) {
  const detailClient = dependencies.detailClient || new SkillDetailClient();
  return detailClient.get(slug, { chain: options.chain, addr: options.addr });
}

export async function listSkillReviews(slug, options = {}, dependencies = {}) {
  const limit = integerOption(options.limit ?? 20, '--limit', 1, 50);
  const detail = await resolveDetail(slug, options, dependencies);
  const reviews = Array.isArray(detail.reviews) ? detail.reviews : [];
  const aggregateCount = detail.rating?.reviewCount;
  const total = Number.isInteger(aggregateCount) && aggregateCount >= reviews.length
    ? aggregateCount
    : reviews.length;
  return {
    ok: true,
    code: 'SKILL_REVIEW_LIST',
    requestedSlug: String(slug),
    slug: detail.canonicalSlug,
    chainId: detail.deployment?.chainId ?? null,
    contractAddr: detail.deployment?.contractAddr ?? null,
    rating: detail.rating || {},
    total,
    returned: Math.min(limit, reviews.length),
    reviews: reviews.slice(0, limit),
  };
}

async function verifyCurrentHolding(detail, wallet, dependencies) {
  if (
    !detail.deployment?.acquirable
    || !Number.isInteger(detail.deployment.chainId)
    || !detail.deployment.contractAddr
  ) {
    throw new ReviewError(
      'REVIEW_DEPLOYMENT_REQUIRED',
      'A currently deployed Skill is required for holder-verified reviews.',
      3,
    );
  }
  const base = {
    slug: detail.canonicalSlug,
    chainId: detail.deployment.chainId,
    contractAddr: detail.deployment.contractAddr,
    wallet,
  };
  try {
    const publicClient = (dependencies.publicClientFactory || getPublicClient)(
      detail.deployment.chainId,
    );
    const isErc721 = await publicClient.readContract({
      address: detail.deployment.contractAddr,
      abi: CHIP_721_ABI,
      functionName: 'supportsInterface',
      args: [IFACE_ID.ERC721],
    });
    const tokenStandard = isErc721 === true ? 'ERC-721' : 'ERC-1155';
    const balance = await publicClient.readContract({
      address: detail.deployment.contractAddr,
      abi: isErc721 === true ? CHIP_721_ABI : CHIP_ABI,
      functionName: 'balanceOf',
      args: isErc721 === true ? [wallet] : [wallet, 1n],
    });
    if (BigInt(balance) <= 0n) {
      throw new ReviewError(
        'REVIEW_LICENSE_REQUIRED',
        'A current Skill license is required to publish a review.',
        3,
        base,
      );
    }
    return { ...base, tokenStandard };
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError(
      'REVIEW_ACCESS_UNAVAILABLE',
      'Unable to verify the current Skill license through RPC.',
      5,
      base,
    );
  }
}

function siteFailure(response, payload, base) {
  const message = typeof payload?.error === 'string' && payload.error
    ? payload.error
    : 'FinChip rejected the review.';
  if (typeof payload?.code === 'string' && payload.code.startsWith('REVIEW_')) {
    const exitCode = response.status >= 500 ? 5 : 3;
    return new ReviewError(payload.code, message, exitCode, base);
  }
  if (response.status === 401) {
    return new ReviewError('AUTH_REQUIRED', 'Run `finchip login` before publishing a review.', 2, base);
  }
  if (response.status === 400) {
    return new ReviewError('REVIEW_INVALID', message, 3, base);
  }
  if (response.status === 409 && /already published/i.test(message)) {
    return new ReviewError('REVIEW_ALREADY_EXISTS', message, 3, base);
  }
  if (response.status === 409 && payload?.code === 'SLUG_ADDR_MISMATCH') {
    return new ReviewError('SKILL_DEPLOYMENT_MISMATCH', message, 3, base);
  }
  if (response.status >= 500) {
    return new ReviewError(
      'REVIEW_SERVICE_UNAVAILABLE',
      'FinChip review service is temporarily unavailable.',
      5,
      base,
    );
  }
  return new ReviewError('REVIEW_FAILED', message, 3, base);
}

function deleteInput(slug, options) {
  const reviewId = String(options.reviewId ?? '').trim();
  if (!reviewId || reviewId.length > 160) {
    throw new ReviewError(
      'REVIEW_INVALID',
      '--review-id must contain 1 to 160 characters.',
      3,
    );
  }
  let canonicalSlug;
  try {
    canonicalSlug = siteLookupSlug(slug);
  } catch (error) {
    throw new ReviewError(
      'REVIEW_INVALID',
      error instanceof Error ? error.message : 'Invalid review deletion target.',
      3,
    );
  }
  if (!options.yes) {
    throw new ReviewError(
      'REVIEW_DELETE_CONFIRM_REQUIRED',
      'Re-run with --yes to delete your public review.',
      3,
      { slug: canonicalSlug, reviewId },
    );
  }
  return { reviewId, canonicalSlug };
}

function deleteSiteFailure(response, payload, base) {
  const message = typeof payload?.error === 'string' && payload.error
    ? payload.error
    : 'FinChip rejected the review deletion.';
  if (response.status === 401) {
    return new ReviewError('AUTH_REQUIRED', 'Run `finchip login` before deleting a review.', 2, base);
  }
  if (response.status === 404) {
    return new ReviewError(
      'REVIEW_NOT_FOUND_OR_NOT_OWNED',
      'The review does not exist or was not published by the logged-in account.',
      3,
      base,
    );
  }
  if (response.status === 409 && payload?.code === 'SLUG_ADDR_MISMATCH') {
    return new ReviewError('SKILL_DEPLOYMENT_MISMATCH', message, 3, base);
  }
  if (response.status >= 500) {
    return new ReviewError(
      'REVIEW_SERVICE_UNAVAILABLE',
      'FinChip review service is temporarily unavailable.',
      5,
      base,
    );
  }
  return new ReviewError('REVIEW_DELETE_FAILED', message, 3, base);
}

export async function deleteSkillReview(slug, options = {}, dependencies = {}) {
  const { reviewId, canonicalSlug } = deleteInput(slug, options);
  const authClient = dependencies.authClient || new FinchipAuthClient();
  if (
    typeof authClient.hasPersistedCredentials === 'function'
    && !authClient.hasPersistedCredentials()
  ) {
    throw new ReviewError('AUTH_REQUIRED', 'Run `finchip login` before deleting a review.', 2);
  }
  const base = {
    slug: canonicalSlug,
    reviewId,
  };

  let response;
  let payload;
  try {
    ({ response, payload } = await authClient.authenticatedJson(
      `/api/v2/skills/${encodeURIComponent(canonicalSlug)}/reviews/${encodeURIComponent(reviewId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    ));
  } catch {
    throw new ReviewError(
      'REVIEW_DELETE_RESULT_UNKNOWN',
      'The review deletion result is unknown. List reviews before trying again.',
      5,
      { ...base, mutationApplied: null },
    );
  }
  if (!response.ok) throw deleteSiteFailure(response, payload, base);
  const rating = payload?.rating && typeof payload.rating === 'object' && !Array.isArray(payload.rating)
    ? payload.rating
    : null;
  return {
    ok: true,
    code: 'SKILL_REVIEW_DELETED',
    ...base,
    confirmationRequired: false,
    rating,
  };
}

export async function submitSkillReview(slug, options = {}, dependencies = {}) {
  const input = submitInput(options);
  const detail = await resolveDetail(slug, options, dependencies);
  const authClient = dependencies.authClient || new FinchipAuthClient();
  const session = await authClient.requireSession({
    walletRequired: true,
    missingMessage: 'Run `finchip login` before publishing a review.',
    expiredMessage: 'FinChip session is expired or has no active wallet.',
  });
  const wallet = session.wallet.walletAddr;
  const holding = await verifyCurrentHolding(detail, wallet, dependencies);
  const preflight = {
    ok: true,
    slug: detail.canonicalSlug,
    chainId: holding.chainId,
    contractAddr: holding.contractAddr,
    wallet,
    tokenStandard: holding.tokenStandard,
    verifiedHolder: true,
    ratings: {
      operationalIndependence: input.operationalIndependence,
      outputQuality: input.outputQuality,
      modelCompatibility: input.modelCompatibility,
    },
    body: input.body,
    videoUrl: input.videoUrl,
  };
  if (options.dryRun) {
    return { ...preflight, code: 'SKILL_REVIEW_DRY_RUN', confirmationRequired: true };
  }
  if (!options.yes) {
    const { ok: _ok, ...details } = preflight;
    throw new ReviewError(
      'REVIEW_CONFIRM_REQUIRED',
      'Review preflight passed. Re-run with --yes to publish this public review.',
      3,
      details,
    );
  }

  let response;
  let payload;
  try {
    ({ response, payload } = await authClient.authenticatedJson(
      `/api/v2/skills/${encodeURIComponent(detail.canonicalSlug)}/reviews`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addr: holding.contractAddr,
          chainId: holding.chainId,
          operational_independence: input.operationalIndependence,
          output_quality: input.outputQuality,
          model_compatibility: input.modelCompatibility,
          body: input.body,
          external_url: input.videoUrl,
        }),
      },
    ));
  } catch {
    throw new ReviewError(
      'REVIEW_SERVICE_UNAVAILABLE',
      'Unable to reach the FinChip review service.',
      5,
      {
        slug: holding.slug,
        chainId: holding.chainId,
        contractAddr: holding.contractAddr,
      },
    );
  }
  const base = {
    slug: holding.slug,
    chainId: holding.chainId,
    contractAddr: holding.contractAddr,
  };
  if (!response.ok) throw siteFailure(response, payload, base);
  if (!payload?.review?.id) {
    throw new ReviewError('REVIEW_FAILED', 'FinChip returned an invalid review result.', 5, base);
  }
  return {
    ...preflight,
    code: 'SKILL_REVIEW_SUBMITTED',
    confirmationRequired: false,
    reviewId: payload.review.id,
    verifiedHolder: payload.review.verifiedHolder === true,
    tokenStandard: payload.review.tokenStandard || holding.tokenStandard,
  };
}
