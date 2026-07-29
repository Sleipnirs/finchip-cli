import assert from 'node:assert/strict';
import test from 'node:test';
import { SkillSearchClient, SkillSearchError } from '../src/skill-search.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

const SKILLS = [
  {
    id: 'skill-2',
    slug: 'second_finchip',
    author_name: 'victor',
    title: 'Second Skill',
    summary: 'Second result',
    version: '1.2.0',
    license: 'MIT',
    tags: ['agent', 'search'],
    category: 'Dev Environment',
    stars: 4,
    downloads: 12,
    is_curated: true,
    source: 'web3',
    chip_address: '0x2222222222222222222222222222222222222222',
    chain_id: 8453,
    chip_price: 0.010000000000000002,
    install_count: 8,
    encrypt_mode: 'oracle-v2',
    rating: 4.8,
    reviewCount: 5,
    certik_status: 'verified',
    certik_verified_at: '2026-07-01T00:00:00.000Z',
    certik_report_url: 'https://example.test/certik',
    finchip_safety_status: 'in_review',
    finchip_safety_verified_at: null,
    finchip_safety_notes: 'Reviewing',
    postRewardsAvailable: true,
    availablePosts: 3,
  },
  {
    id: 'skill-1',
    slug: 'first_finchip',
    title: 'First Skill',
  },
];

test('public skill search preserves the query and sends no credentials to the cacheable endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return jsonResponse({ skills: SKILLS, total: 27, limit: 20, offset: 20 });
  };
  const client = new SkillSearchClient({ origin: 'https://finchip.ai/path', fetchImpl });

  const result = await client.search('  audit agent wallet security extra  ', {
    category: 'Dev Environment',
    sort: 'rating',
    curated: true,
    limit: '20',
    offset: '20',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://finchip.ai');
  assert.equal(calls[0].url.pathname, '/api/skills');
  assert.equal(calls[0].url.searchParams.get('search'), 'audit agent wallet security extra');
  assert.equal(calls[0].url.searchParams.get('source'), 'web3');
  assert.equal(calls[0].url.searchParams.get('sort'), 'rating');
  assert.equal(calls[0].url.searchParams.get('category'), 'Dev Environment');
  assert.equal(calls[0].url.searchParams.get('curated'), '1');
  assert.equal(calls[0].url.searchParams.get('limit'), '20');
  assert.equal(calls[0].url.searchParams.get('offset'), '20');
  assert.equal(calls[0].url.searchParams.has('on_chain'), false);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.get('Accept'), 'application/json');
  assert.equal(calls[0].init.headers.has('Cookie'), false);
  assert.equal(calls[0].init.headers.has('Authorization'), false);
  assert.equal(calls[0].init.headers.has('Origin'), false);

  assert.deepEqual(result.pagination, { total: 27, limit: 20, offset: 20 });
  assert.deepEqual(result.skills.map(skill => skill.slug), ['second_finchip', 'first_finchip']);
  assert.equal(result.skills[0].deployment.price, 0.010000000000000002);
  assert.equal(result.skills[0].deployment.encryptionMode, 'oracle-v2');
  assert.deepEqual(result.skills[0].safety, {
    certik: {
      status: 'verified',
      verifiedAt: '2026-07-01T00:00:00.000Z',
      reportUrl: 'https://example.test/certik',
    },
    finchip: {
      status: 'in_review',
      verifiedAt: null,
      notes: 'Reviewing',
    },
  });
  assert.deepEqual(result.skills[0].postRewards, { available: true, count: 3 });
  assert.equal(result.skills[1].author, null);
  assert.equal(result.skills[1].deployment.contractAddr, null);
  assert.equal(result.skills[1].reviewCount, 0);
});

test('public skill list omits search while preserving category, sorting, and pagination', async () => {
  const calls = [];
  const client = new SkillSearchClient({
    origin: 'https://finchip.ai/path',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse({ skills: SKILLS, total: 27, limit: 10, offset: 20 });
    },
  });

  const result = await client.list({
    category: 'Security Audit',
    sort: 'new',
    curated: true,
    limit: '10',
    offset: '20',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/skills');
  assert.equal(calls[0].url.searchParams.has('search'), false);
  assert.equal(calls[0].url.searchParams.get('source'), 'web3');
  assert.equal(calls[0].url.searchParams.get('category'), 'Security Audit');
  assert.equal(calls[0].url.searchParams.get('sort'), 'new');
  assert.equal(calls[0].url.searchParams.get('curated'), '1');
  assert.equal(calls[0].url.searchParams.get('limit'), '10');
  assert.equal(calls[0].url.searchParams.get('offset'), '20');
  assert.equal(calls[0].url.searchParams.has('on_chain'), false);
  assert.equal(calls[0].init.headers.has('Cookie'), false);
  assert.equal(calls[0].init.headers.has('Authorization'), false);
  assert.equal(calls[0].init.headers.has('Origin'), false);
  assert.equal('query' in result, false);
  assert.deepEqual(result.filters, {
    category: 'Security Audit',
    sort: 'new',
    curated: true,
    source: 'web3',
  });
  assert.deepEqual(result.pagination, { total: 27, limit: 10, offset: 20 });
  assert.equal(result.skills.length, 2);
});

test('skill search validates its public parameter contract before fetching', async () => {
  let calls = 0;
  const client = new SkillSearchClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ skills: [], total: 0, limit: 20, offset: 0 });
    },
  });
  const invalid = [
    ['', {}],
    ['x'.repeat(65), {}],
    ['audit', { sort: 'popular' }],
    ['audit', { limit: '0' }],
    ['audit', { limit: '101' }],
    ['audit', { offset: '-1' }],
    ['audit', { offset: '100001' }],
    ['audit', { category: '   ' }],
  ];

  for (const [query, options] of invalid) {
    await assert.rejects(
      () => client.search(query, options),
      error => error instanceof SkillSearchError && error.code === 'SEARCH_INVALID' && error.exitCode === 3
    );
  }
  assert.equal(calls, 0);
});

test('skill list validates filters with list-specific errors before fetching', async () => {
  let calls = 0;
  const client = new SkillSearchClient({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ skills: [], total: 0, limit: 20, offset: 0 });
    },
  });

  for (const options of [
    { sort: 'popular' },
    { limit: '0' },
    { limit: '101' },
    { offset: '-1' },
    { offset: '100001' },
    { category: '   ' },
  ]) {
    await assert.rejects(
      () => client.list(options),
      error => error instanceof SkillSearchError && error.code === 'LIST_INVALID' && error.exitCode === 3
    );
  }
  assert.equal(calls, 0);
});

test('skill search maps upstream and malformed responses to stable errors', async () => {
  const cases = [
    {
      response: jsonResponse({ error: 'Invalid category' }, { status: 400 }),
      code: 'SEARCH_INVALID',
      exitCode: 3,
    },
    {
      response: new Response('<html>edge limited</html>', {
        status: 429,
        headers: { 'Content-Type': 'text/html', 'Retry-After': '7' },
      }),
      code: 'SEARCH_RATE_LIMITED',
      exitCode: 5,
      retryAfterSeconds: 7,
    },
    {
      response: new Response('<html>database unavailable</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }),
      code: 'SEARCH_SERVICE_UNAVAILABLE',
      exitCode: 5,
    },
    {
      response: new Response('{bad json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      code: 'SEARCH_FAILED',
      exitCode: 5,
    },
    {
      response: jsonResponse({ skills: {}, total: 0, limit: 20, offset: 0 }),
      code: 'SEARCH_FAILED',
      exitCode: 5,
    },
  ];

  for (const expected of cases) {
    const client = new SkillSearchClient({ fetchImpl: async () => expected.response });
    await assert.rejects(
      () => client.search('audit'),
      error => error instanceof SkillSearchError
        && error.code === expected.code
        && error.exitCode === expected.exitCode
        && (expected.retryAfterSeconds == null || error.details.retryAfterSeconds === expected.retryAfterSeconds)
    );
  }
});

test('skill search maps timeout and network failures without leaking their messages', async () => {
  const timeoutClient = new SkillSearchClient({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('secret timeout detail');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(
    () => timeoutClient.search('audit'),
    error => error.code === 'SEARCH_SERVICE_UNAVAILABLE'
      && /timed out/i.test(error.message)
      && !/secret/.test(error.message)
  );

  const networkClient = new SkillSearchClient({
    fetchImpl: async () => { throw new Error('request included Cookie=secret'); },
  });
  await assert.rejects(
    () => networkClient.search('audit'),
    error => error.code === 'SEARCH_SERVICE_UNAVAILABLE'
      && !/Cookie|secret/.test(error.message)
  );

  const bodyFailureClient = new SkillSearchClient({
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('response body contained secret'));
      },
    })),
  });
  await assert.rejects(
    () => bodyFailureClient.search('audit'),
    error => error.code === 'SEARCH_SERVICE_UNAVAILABLE'
      && !/secret/.test(error.message)
  );
});
