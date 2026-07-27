import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveOriginCredentials } from '../src/auth-client.js';
import { SkillDetailClient, SkillDetailError } from '../src/skill-detail.js';

const ADDR = '0x1111111111111111111111111111111111111111';

function detailPayload(overrides = {}) {
  return {
    skill: {
      id: 'skill-1',
      slug: 'audit_finchip',
      title: 'Audit',
      summary: 'Security audit',
      description: 'Detailed description',
      author_name: 'victor',
      version: '1.0.0',
      license: 'MIT',
      category: 'Security Audit',
      tags: ['security'],
      source: 'web3',
      is_curated: true,
      stars: 4,
      downloads: 12,
      is_on_chain: true,
      chain_id: 56,
      chip_address: ADDR,
      chip_price: 0.01,
      install_count: 2,
      is_encrypted: true,
      certik_status: 'verified',
      finchip_safety_status: 'verified',
      ...overrides,
    },
    v2: {
      rating: { average: 4.5, count: 2 },
      weeklyStats: { downloads: 3 },
      reviews: [],
      viewer: null,
      supportedAgents: [{ key: 'codex-cli' }],
      references: [],
      relatedSkills: [],
      benchmark: {},
      postRewardsAvailable: true,
      postRewardCampaign: { id: 'campaign-1' },
    },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('public detail is anonymous, canonical, and maps a stable consumer result', async () => {
  const calls = [];
  const client = new SkillDetailClient({
    origin: 'https://finchip.ai/path',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return jsonResponse(detailPayload());
    },
  });

  const result = await client.get('alias');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://finchip.ai/api/v2/skills/alias');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.get('Accept'), 'application/json');
  assert.equal(calls[0].init.headers.has('Cookie'), false);
  assert.equal(calls[0].init.headers.has('Authorization'), false);
  assert.equal(calls[0].init.headers.has('Origin'), false);
  assert.equal(result.requestedSlug, 'alias');
  assert.equal(result.canonicalSlug, 'audit_finchip');
  assert.equal(result.skill.author, 'victor');
  assert.equal(result.deployment.acquirable, true);
  assert.equal(result.deployment.chainId, 56);
  assert.equal(result.deployment.contractAddr, ADDR);
  assert.deepEqual(result.postRewards, {
    available: true,
    campaign: { id: 'campaign-1' },
  });
  assert.equal(result.viewer, null);
});

test('public detail uses the same effective display overrides as the Site', async () => {
  const client = new SkillDetailClient({
    fetchImpl: async () => jsonResponse(detailPayload({
      display_overrides: {
        category: 'Agent Tooling',
        summary: 'Managed summary',
        description: 'Managed description',
      },
    })),
  });

  const result = await client.get('audit_finchip');

  assert.equal(result.skill.category, 'Agent Tooling');
  assert.equal(result.skill.summary, 'Managed summary');
  assert.equal(result.skill.description, 'Managed description');
});

test('public detail verifies an exact deployment instead of accepting Site slug fallback', async () => {
  const client = new SkillDetailClient({
    fetchImpl: async () => jsonResponse(detailPayload()),
  });

  await assert.rejects(
    () => client.get('audit_finchip', {
      chain: 'base',
      addr: '0x2222222222222222222222222222222222222222',
    }),
    error => error instanceof SkillDetailError
      && error.code === 'SKILL_DEPLOYMENT_MISMATCH'
      && error.details.requestedChainId === 8453
  );
});

test('public detail validates pairs and maps upstream failures without leaking response data', async () => {
  const client = new SkillDetailClient({
    fetchImpl: async () => { throw new Error('Cookie=secret'); },
  });
  await assert.rejects(
    () => client.get('audit_finchip', { chain: 'bsc' }),
    error => error.code === 'SKILL_SHOW_INVALID' && error.exitCode === 3
  );
  await assert.rejects(
    () => client.get('audit_finchip'),
    error => error.code === 'SKILL_DETAIL_UNAVAILABLE' && !/Cookie|secret/.test(error.message)
  );

  const cases = [
    [jsonResponse({ error: 'missing' }, { status: 404 }), 'SKILL_NOT_FOUND'],
    [jsonResponse({ error: 'down' }, { status: 503 }), 'SKILL_DETAIL_UNAVAILABLE'],
    [jsonResponse({}, { status: 302, headers: { Location: 'https://evil.test/' } }), 'SKILL_DETAIL_FAILED'],
    [jsonResponse({ skill: [], v2: {} }), 'SKILL_DETAIL_FAILED'],
  ];
  for (const [response, code] of cases) {
    const failing = new SkillDetailClient({ fetchImpl: async () => response });
    await assert.rejects(() => failing.get('audit_finchip'), error => error.code === code);
  }
});

test('skill show CLI remains anonymous even when local login cookies exist', async () => {
  let observed;
  const server = createServer((req, res) => {
    observed = {
      url: req.url,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(detailPayload()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-skill-show-'));
  const credentialsPath = join(root, 'credentials.json');
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
    finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
  }, { path: credentialsPath });

  try {
    const result = await runCli(['skill', 'show', 'alias', '--json'], {
      FINCHIP_API_URL: origin,
      FINCHIP_CREDENTIALS_PATH: credentialsPath,
    });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'SKILL_PUBLIC_DETAIL');
    assert.equal(payload.canonicalSlug, 'audit_finchip');
    assert.equal(observed.url, '/api/v2/skills/alias');
    assert.equal(observed.cookie, undefined);
    assert.equal(observed.authorization, undefined);
    assert.equal(observed.origin, undefined);
    assert.doesNotMatch(result.stdout, /account-secret|wallet-secret/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
