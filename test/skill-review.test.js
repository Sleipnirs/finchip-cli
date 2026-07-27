import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteSkillReview,
  ReviewError,
  listSkillReviews,
  submitSkillReview,
} from '../src/skill-review.js';

const CHIP = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

function detail(overrides = {}) {
  return {
    canonicalSlug: 'audit-pro-finchip',
    deployment: {
      acquirable: true,
      chainId: 56,
      contractAddr: CHIP,
    },
    rating: {
      averageRating: 4.5,
      reviewCount: 2,
    },
    reviews: [
      { id: 'review-1', username: 'alice', overall: 5, content: 'Excellent.' },
      { id: 'review-2', username: 'bob', overall: 4, content: 'Useful.' },
    ],
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const posts = [];
  return {
    posts,
    deps: {
      detailClient: {
        async get() {
          return detail();
        },
      },
      authClient: {
        async requireSession() {
          return { wallet: { walletAddr: WALLET } };
        },
        async authenticatedJson(path, options) {
          posts.push({ path, options, body: JSON.parse(options.body) });
          return {
            response: new Response(JSON.stringify({
              review: {
                id: 'review-new',
                verifiedHolder: true,
                tokenStandard: 'ERC-1155',
              },
            }), { status: 201 }),
            payload: {
              review: {
                id: 'review-new',
                verifiedHolder: true,
                tokenStandard: 'ERC-1155',
              },
            },
          };
        },
      },
      publicClientFactory() {
        return {
          async readContract({ functionName }) {
            if (functionName === 'supportsInterface') return false;
            if (functionName === 'balanceOf') return 1n;
            throw new Error(`Unexpected getter ${functionName}`);
          },
        };
      },
      ...overrides,
    },
  };
}

const submitOptions = {
  operationalIndependence: '5',
  outputQuality: '4',
  modelCompatibility: '5',
  body: 'Works reliably in an agent workflow.',
};

test('review list is anonymous, stable, and bounded locally without changing Site order', async () => {
  const calls = [];
  const result = await listSkillReviews('alias', { limit: '1' }, {
    detailClient: {
      async get(slug, options) {
        calls.push({ slug, options });
        return detail();
      },
    },
  });

  assert.deepEqual(calls, [{ slug: 'alias', options: { chain: undefined, addr: undefined } }]);
  assert.equal(result.code, 'SKILL_REVIEW_LIST');
  assert.equal(result.slug, 'audit-pro-finchip');
  assert.equal(result.total, 2);
  assert.equal(result.returned, 1);
  assert.deepEqual(result.reviews.map(review => review.id), ['review-1']);
});

test('review list uses the aggregate count when Site returns only its bounded review window', async () => {
  const result = await listSkillReviews('audit-pro-finchip', {}, {
    detailClient: {
      async get() {
        return detail({
          rating: { averageRating: 4.7, reviewCount: 73 },
        });
      },
    },
  });

  assert.equal(result.total, 73);
  assert.equal(result.returned, 2);
});

test('review submit requires a current holding and explicit confirmation before POST', async () => {
  const { deps, posts } = dependencies();

  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', submitOptions, deps),
    error => error instanceof ReviewError
      && error.code === 'REVIEW_CONFIRM_REQUIRED'
      && error.details.tokenStandard === 'ERC-1155'
  );
  assert.equal(posts.length, 0);

  const dryRun = await submitSkillReview(
    'audit-pro-finchip',
    { ...submitOptions, dryRun: true },
    deps,
  );
  assert.equal(dryRun.code, 'SKILL_REVIEW_DRY_RUN');
  assert.equal(dryRun.wallet, WALLET);
  assert.equal(posts.length, 0);
});

test('review submit posts cookie-authenticated content without wallet signatures', async () => {
  const { deps, posts } = dependencies();
  const result = await submitSkillReview(
    'audit-pro-finchip',
    { ...submitOptions, yes: true, videoUrl: 'https://youtu.be/abcdefghijk' },
    deps,
  );

  assert.equal(result.code, 'SKILL_REVIEW_SUBMITTED');
  assert.equal(result.reviewId, 'review-new');
  assert.equal(result.verifiedHolder, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/v2/skills/audit-pro-finchip/reviews');
  assert.equal(posts[0].options.method, 'POST');
  assert.deepEqual(posts[0].body, {
    addr: CHIP,
    chainId: 56,
    operational_independence: 5,
    output_quality: 4,
    model_compatibility: 5,
    body: submitOptions.body,
    external_url: 'https://youtu.be/abcdefghijk',
  });
  assert.equal('wallet_addr' in posts[0].body, false);
  assert.equal('signature' in posts[0].body, false);
});

test('review deletion stays available without a current license and uses only account ownership', async () => {
  const requests = [];
  let detailCalls = 0;
  let rpcCalls = 0;
  const deps = {
    detailClient: {
      async get() {
        detailCalls += 1;
        throw new Error('Review deletion must not prefetch public detail.');
      },
    },
    authClient: {
      hasPersistedCredentials() {
        return true;
      },
      async authenticatedJson(path, options) {
        requests.push({ path, options, body: JSON.parse(options.body) });
        return {
          response: new Response(JSON.stringify({
            rating: { reviewCount: 1, averageRating: 4.5 },
          }), { status: 200 }),
          payload: {
            rating: { reviewCount: 1, averageRating: 4.5 },
          },
        };
      },
    },
    publicClientFactory() {
      rpcCalls += 1;
      throw new Error('Review deletion must not inspect the transferred license.');
    },
  };

  const result = await deleteSkillReview('audit-pro-finchip', {
    reviewId: 'review-1',
    yes: true,
  }, deps);

  assert.equal(result.code, 'SKILL_REVIEW_DELETED');
  assert.equal(detailCalls, 0);
  assert.equal(rpcCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/v2/skills/audit-pro-finchip/reviews/review-1');
  assert.equal(requests[0].options.method, 'DELETE');
  assert.deepEqual(requests[0].body, {});
});

test('review deletion requires explicit confirmation and maps ownership errors', async () => {
  const current = dependencies();
  await assert.rejects(
    () => deleteSkillReview('audit-pro-finchip', { reviewId: 'review-1' }, current.deps),
    error => error.code === 'REVIEW_DELETE_CONFIRM_REQUIRED'
  );
  assert.equal(current.posts.length, 0);

  const notOwned = dependencies({
    authClient: {
      async authenticatedJson() {
        return {
          response: new Response(JSON.stringify({ error: 'Review not found.' }), { status: 404 }),
          payload: { error: 'Review not found.' },
        };
      },
    },
  });
  await assert.rejects(
    () => deleteSkillReview('audit-pro-finchip', {
      reviewId: 'review-1',
      yes: true,
    }, notOwned.deps),
    error => error.code === 'REVIEW_NOT_FOUND_OR_NOT_OWNED'
  );
});

test('review submit handles ERC-721 holdings and fails closed on missing licenses or RPC', async () => {
  const erc721 = dependencies({
    publicClientFactory: () => ({
      async readContract({ functionName, args }) {
        if (functionName === 'supportsInterface') return true;
        assert.deepEqual(args, [WALLET]);
        return 1n;
      },
    }),
  });
  const result = await submitSkillReview(
    'audit-pro-finchip',
    { ...submitOptions, dryRun: true },
    erc721.deps,
  );
  assert.equal(result.tokenStandard, 'ERC-721');

  const noLicense = dependencies({
    publicClientFactory: () => ({
      async readContract({ functionName }) {
        return functionName === 'supportsInterface' ? false : 0n;
      },
    }),
  });
  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', { ...submitOptions, dryRun: true }, noLicense.deps),
    error => error.code === 'REVIEW_LICENSE_REQUIRED'
  );

  const rpcFailure = dependencies({
    publicClientFactory: () => ({
      async readContract() {
        throw new Error('RPC down');
      },
    }),
  });
  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', { ...submitOptions, dryRun: true }, rpcFailure.deps),
    error => error.code === 'REVIEW_ACCESS_UNAVAILABLE'
  );
});

test('review input and Site authorization failures map to stable codes', async () => {
  const { deps } = dependencies();
  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', {
      ...submitOptions,
      operationalIndependence: '6',
    }, deps),
    error => error.code === 'REVIEW_INVALID'
  );
  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', {
      ...submitOptions,
      dryRun: true,
      yes: true,
    }, deps),
    error => error.code === 'REVIEW_INVALID'
  );
  await assert.rejects(
    () => submitSkillReview('audit-pro-finchip', {
      ...submitOptions,
      videoUrl: 'https://example.com/not-a-review-video',
    }, deps),
    error => error.code === 'REVIEW_INVALID'
  );

  const cases = [
    [400, { error: 'Ratings must be whole numbers between 1 and 5.' }, 'REVIEW_INVALID'],
    [403, { code: 'REVIEW_CREATOR_FORBIDDEN', error: 'creator' }, 'REVIEW_CREATOR_FORBIDDEN'],
    [403, { code: 'REVIEW_LICENSE_REQUIRED', error: 'license' }, 'REVIEW_LICENSE_REQUIRED'],
    [409, { error: 'You have already published a review for this skill.' }, 'REVIEW_ALREADY_EXISTS'],
    [503, { code: 'REVIEW_ACCESS_UNAVAILABLE', error: 'rpc' }, 'REVIEW_ACCESS_UNAVAILABLE'],
    [500, { error: 'database' }, 'REVIEW_SERVICE_UNAVAILABLE'],
  ];
  for (const [status, payload, code] of cases) {
    const current = dependencies({
      authClient: {
        async requireSession() {
          return { wallet: { walletAddr: WALLET } };
        },
        async authenticatedJson() {
          return {
            response: new Response(JSON.stringify(payload), { status }),
            payload,
          };
        },
      },
    });
    await assert.rejects(
      () => submitSkillReview('audit-pro-finchip', { ...submitOptions, yes: true }, current.deps),
      error => error.code === code
    );
  }
});
