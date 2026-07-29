import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { saveOriginCredentials } from '../src/auth-client.js';
import {
  buildEditableManageState,
  buildManagePatch,
  validateManageDocument,
  verifyManagedCollections,
} from '../src/manage-config.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const SKILL_ID = '00000000-0000-4000-8000-000000000001';
const RELATED_ID = '00000000-0000-4000-8000-000000000002';

function runCli(args, env = {}, stdin = 'ignore') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (stdin !== 'ignore') child.stdin.end(stdin);
  });
}

test('manage document validates nested fields and converts only Site text-null fields', () => {
  const input = {
    displayOverrides: {
      category: null,
      summary: null,
      description: '',
      creatorStudioDescription: null,
      videoUrl: null,
    },
    instructionOverrides: {
      audience: ['creator', 'builder'],
      runtime: { tools: 'node', permissions: null },
      examplePrompt: null,
      exampleOutput: [{ label: 'Result', value: 'ok' }],
    },
    supportedAgents: [{ key: 'codex-cli', note: 'tested' }],
    relatedSkillSlugs: ['other_finchip'],
  };
  assert.deepEqual(validateManageDocument(input), input);
  assert.deepEqual(buildManagePatch(input, ['00000000-0000-4000-8000-000000000001']), {
    displayOverrides: {
      category: null,
      summary: '',
      description: '',
      creatorStudioDescription: '',
      videoUrl: null,
    },
    instructionOverrides: input.instructionOverrides,
    supportedAgents: input.supportedAgents,
    relatedSkillIds: ['00000000-0000-4000-8000-000000000001'],
  });

  assert.throws(
    () => validateManageDocument({ displayOverrides: { imagePath: null } }),
    error => error.code === 'MANAGE_INVALID' && /imagePath/.test(error.message),
  );
  assert.throws(
    () => validateManageDocument({ displayOverrides: { summary: 'x'.repeat(281) } }),
    error => error.code === 'MANAGE_INVALID',
  );
  assert.throws(
    () => validateManageDocument({ supportedAgents: [{ key: 'future-agent' }] }),
    error => error.code === 'MANAGE_INVALID',
  );
  assert.throws(
    () => validateManageDocument({ instructionOverrides: { runtime: { typo: 'x' } } }),
    error => error.code === 'MANAGE_INVALID',
  );
});

test('editable manage state excludes imagePath but preserves raw state', () => {
  const payload = {
    skill: {
      id: 'skill-1',
      slug: 'demo_finchip',
      display_overrides: {
        imagePath: 'skills/skill-1/display/a.png',
        category: 'Security Audit',
        summary: 'summary',
      },
      instruction_overrides: { audience: ['builder'] },
    },
    supportedAgents: [{ key: 'codex-cli', note: 'tested', iconUrl: '/codex.svg' }],
    relatedSkills: [{ id: 'skill-2', slug: 'other_finchip' }],
    studio: null,
  };
  const result = buildEditableManageState(payload);
  assert.equal(result.state.skill.display_overrides.imagePath, 'skills/skill-1/display/a.png');
  assert.equal(Object.hasOwn(result.editable.displayOverrides, 'imagePath'), false);
  assert.deepEqual(result.editable.relatedSkillSlugs, ['other_finchip']);
  assert.deepEqual(result.editable.supportedAgents, [{ key: 'codex-cli', note: 'tested' }]);
});

test('post-PATCH verification detects silently dropped or reordered collections', () => {
  assert.deepEqual(
    verifyManagedCollections(
      { supportedAgents: [{ key: 'codex-cli' }], relatedSkillSlugs: ['one_finchip'] },
      { supportedAgents: [{ key: 'codex-cli' }], relatedSkills: [{ slug: 'one_finchip' }] },
    ),
    null,
  );
  const mismatch = verifyManagedCollections(
    { supportedAgents: [{ key: 'codex-cli' }, { key: 'claude-code' }] },
    { supportedAgents: [{ key: 'codex-cli' }], relatedSkills: [] },
  );
  assert.equal(mismatch.code, 'MANAGE_VERIFICATION_FAILED');
  assert.equal(mismatch.mutationApplied, true);
  assert.deepEqual(mismatch.missing, ['claude-code']);
});

test('manage get follows canonical slug and apply sends cookie-only allowlisted PATCH with readback', async () => {
  const requests = [];
  let applied = false;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : null;
      requests.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        body,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/auth/session') {
        res.end(JSON.stringify({
          authenticated: true,
          wallet: { walletAddr: '0x2222222222222222222222222222222222222222' },
          identity: { userId: 'user-1' },
        }));
        return;
      }
      if (req.url === `/api/v2/skills/alias/manage?addr=${ADDR}&chainId=56`) {
        res.end(JSON.stringify({ canonicalSlug: 'demo_finchip' }));
        return;
      }
      if (req.url === `/api/v2/skills/demo-finchip/manage?addr=${ADDR}&chainId=56` && req.method === 'GET') {
        res.end(JSON.stringify({
          skill: {
            id: SKILL_ID,
            slug: 'demo_finchip',
            chip_address: ADDR,
            chain_id: 56,
            display_overrides: { imagePath: 'skills/skill-1/display/old.png', summary: applied ? null : 'old' },
            instruction_overrides: {},
          },
          supportedAgents: applied ? [{ key: 'codex-cli', note: 'tested' }] : [],
          relatedSkills: applied ? [{ id: RELATED_ID, slug: 'other-finchip' }] : [],
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/manage?searchRelated=other-finchip') {
        res.end(JSON.stringify({
          candidates: [{ id: RELATED_ID, slug: 'other-finchip', title: 'Other' }],
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/manage' && req.method === 'PATCH') {
        assert.deepEqual(body, {
          displayOverrides: { summary: '' },
          supportedAgents: [{ key: 'codex-cli', note: 'tested' }],
          relatedSkillIds: [RELATED_ID],
          addr: ADDR,
          chainId: 56,
        });
        assert.equal(body.imagePath, undefined);
        assert.equal(body.wallet_addr, undefined);
        assert.equal(body.signature, undefined);
        applied = true;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-manage-config-'));
  const credentialsPath = join(root, 'credentials.json');
  const configPath = join(root, 'manage.json');
  writeFileSync(configPath, JSON.stringify({
    displayOverrides: { summary: null },
    supportedAgents: [{ key: 'codex-cli', note: 'tested' }],
    relatedSkillSlugs: ['other_finchip'],
  }));
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
  }, { path: credentialsPath });
  const env = { FINCHIP_API_URL: origin, FINCHIP_CREDENTIALS_PATH: credentialsPath };
  try {
    const get = await runCli(['skill', 'manage', 'get', 'alias', '--chain', '56', '--addr', ADDR, '--json'], env);
    assert.equal(get.code, 0, `${get.stderr}\n${get.stdout}`);
    const getResult = JSON.parse(get.stdout);
    assert.equal(getResult.code, 'SKILL_MANAGE_STATE');
    assert.equal(getResult.slug, 'demo-finchip');
    assert.equal(Object.hasOwn(getResult.editable.displayOverrides, 'imagePath'), false);

    const apply = await runCli([
      'skill', 'manage', 'apply', 'alias', '--file', configPath,
      '--chain', '56', '--addr', ADDR, '--json',
    ], env);
    assert.equal(apply.code, 0, `${apply.stderr}\n${apply.stdout}`);
    assert.equal(JSON.parse(apply.stdout).code, 'SKILL_MANAGE_UPDATED');
    const patchRequest = requests.find(request => request.method === 'PATCH');
    assert.match(patchRequest.cookie, /finchip_account_session=account-secret/);
    assert.equal(patchRequest.authorization, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('manage apply supports stdin, dry-run, input limit, and validates before PATCH', async () => {
  const help = await runCli(['skill', 'manage', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /get \[options\] <slug>/);
  assert.match(help.stdout, /apply \[options\] <slug>/);

  const invalid = await runCli(
    ['skill', 'manage', 'apply', 'demo_finchip', '--file', '-', '--json'],
    { FINCHIP_API_URL: 'http://127.0.0.1:1' },
    JSON.stringify({ typo: true }),
  );
  assert.equal(invalid.code, 3, `${invalid.stderr}\n${invalid.stdout}`);
  assert.equal(JSON.parse(invalid.stdout).code, 'MANAGE_INVALID');

  const oversized = await runCli(
    ['skill', 'manage', 'apply', 'demo_finchip', '--file', '-', '--json'],
    { FINCHIP_API_URL: 'http://127.0.0.1:1' },
    `${' '.repeat(1024 * 1024)}x`,
  );
  assert.equal(oversized.code, 3, `${oversized.stderr}\n${oversized.stdout}`);
  assert.equal(JSON.parse(oversized.stdout).code, 'MANAGE_INVALID');
});
