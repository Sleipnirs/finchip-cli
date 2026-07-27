import { deleteSkillReview, listSkillReviews, submitSkillReview } from '../skill-review.js';
import { emitFailure, emitResult, fmtChain, hd, inf, ok, sep } from '../utils.js';

function renderReview(review) {
  const author = review.username || review.handle || 'unknown reviewer';
  const score = review.overall == null ? 'unrated' : `${review.overall}/5`;
  ok(`${author} · ${score}`);
  if (review.createdAt) inf(`published: ${review.createdAt}`);
  if (review.content) inf(review.content);
  if (review.externalUrl) inf(`video: ${review.externalUrl}`);
}

export async function cmdSkillReviewList(slug, options = {}, dependencies = {}) {
  try {
    const result = await listSkillReviews(slug, options, dependencies);
    emitResult(options, result, () => {
      hd(`FinChip Skill Reviews — ${result.slug}`);
      sep();
      if (!result.reviews.length) {
        inf('No published reviews.');
      } else {
        for (const review of result.reviews) {
          renderReview(review);
          console.log('');
        }
      }
      inf(`Returned ${result.returned} of ${result.total} reviews.`);
    });
  } catch (error) {
    emitFailure(options, error, {
      code: 'REVIEW_FAILED',
      message: 'FinChip Skill review lookup failed.',
    });
  }
}

export async function cmdSkillReviewSubmit(slug, options = {}, dependencies = {}) {
  try {
    const result = await submitSkillReview(slug, options, dependencies);
    emitResult(options, result, () => {
      hd(options.dryRun ? 'FinChip Skill Review — dry run' : 'FinChip Skill Review');
      sep();
      ok(options.dryRun ? 'Review preflight passed.' : `Review published: ${result.reviewId}`);
      inf(`skill:    ${result.slug}`);
      inf(`chain:    ${fmtChain(result.chainId)}`);
      inf(`contract: ${result.contractAddr}`);
      inf(`wallet:   ${result.wallet}`);
      inf(`standard: ${result.tokenStandard}`);
      inf('holder:   verified at submission time');
      if (options.dryRun) inf('Re-run with --yes to publish this public review.');
    });
  } catch (error) {
    emitFailure(options, error, {
      code: 'REVIEW_FAILED',
      message: 'FinChip Skill review submission failed.',
    });
  }
}

export async function cmdSkillReviewDelete(slug, options = {}, dependencies = {}) {
  try {
    const result = await deleteSkillReview(slug, options, dependencies);
    emitResult(options, result, () => {
      hd('FinChip Skill Review Delete');
      sep();
      ok(`Review deleted: ${result.reviewId}`);
      inf(`skill:    ${result.slug}`);
      inf(`review:   ${result.reviewId}`);
      inf('license:  not required for deleting your own review');
    });
  } catch (error) {
    emitFailure(options, error, {
      code: 'REVIEW_DELETE_FAILED',
      message: 'FinChip Skill review deletion failed.',
    });
  }
}
