import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveOriginCredentials } from '../src/auth-client.js';

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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('skill search CLI returns stable JSON and never sends persisted credentials', async () => {
  let observed = null;
  const server = createServer((req, res) => {
    observed = {
      url: new URL(req.url, 'http://localhost'),
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      skills: [{
        id: 'skill-1',
        slug: 'audit_finchip',
        title: 'Audit',
        summary: 'Agent security audit',
        author_name: 'victor',
        source: 'web3',
        chain_id: 56,
        chip_address: '0x1111111111111111111111111111111111111111',
        chip_price: 0.02,
      }],
      total: 1,
      limit: 5,
      offset: 10,
    }));
  });
  const address = await listen(server);
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-skill-search-'));
  const credentialsPath = join(root, 'credentials.json');
  saveOriginCredentials(apiOrigin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
    finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
  }, { path: credentialsPath });

  try {
    const result = await runCli([
      'skill', 'search', 'audit wallet',
      '--category', 'Security Audit',
      '--sort', 'new',
      '--curated',
      '--limit', '5',
      '--offset', '10',
      '--json',
    ], {
      FINCHIP_API_URL: apiOrigin,
      FINCHIP_CREDENTIALS_PATH: credentialsPath,
    });

    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'SKILL_SEARCH_RESULTS');
    assert.equal(payload.query, 'audit wallet');
    assert.deepEqual(payload.filters, {
      category: 'Security Audit',
      sort: 'new',
      curated: true,
      source: 'web3',
    });
    assert.deepEqual(payload.pagination, { total: 1, limit: 5, offset: 10 });
    assert.equal(payload.skills[0].deployment.price, 0.02);
    assert.equal('hasMore' in payload.pagination, false);
    assert.doesNotMatch(result.stdout, /account-secret|wallet-secret/);

    assert.equal(observed.url.pathname, '/api/skills');
    assert.equal(observed.url.searchParams.get('search'), 'audit wallet');
    assert.equal(observed.url.searchParams.get('source'), 'web3');
    assert.equal(observed.url.searchParams.has('on_chain'), false);
    assert.equal(observed.cookie, undefined);
    assert.equal(observed.authorization, undefined);
    assert.equal(observed.origin, undefined);
  } finally {
    await close(server);
  }
});

test('skill search text reports an unknown total when Site returns zero with results', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      skills: [{
        id: 'skill-1',
        slug: 'audit_finchip',
        title: 'Audit',
        summary: 'Agent security audit',
        author_name: 'victor',
        category: 'Security Audit',
        downloads: 20,
        rating: 4.5,
        reviewCount: 2,
        chain_id: 56,
        chip_address: '0x1111111111111111111111111111111111111111',
        chip_price: 0.02,
        finchip_safety_status: 'verified',
      }],
      total: 0,
      limit: 20,
      offset: 0,
    }));
  });
  const address = await listen(server);
  try {
    const result = await runCli(['skill', 'search', 'audit'], {
      FINCHIP_API_URL: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /audit_finchip/);
    assert.match(result.stdout, /Agent security audit/);
    assert.match(result.stdout, /total unknown/i);
    assert.doesNotMatch(result.stdout, /total 0/i);
    assert.match(result.stdout, /finchip skill show audit_finchip/);
    assert.match(result.stdout, /finchip acquire --slug audit_finchip.*--dry-run/);

    const jsonResult = await runCli(['skill', 'search', 'audit', '--json'], {
      FINCHIP_API_URL: `http://127.0.0.1:${address.port}`,
    });
    assert.equal(jsonResult.code, 0, `${jsonResult.stderr}\n${jsonResult.stdout}`);
    const payload = JSON.parse(jsonResult.stdout);
    assert.equal(payload.pagination.total, 0);
    assert.equal(payload.skills.length, 1);
  } finally {
    await close(server);
  }
});

test('skill search help is present while market search remains the legacy list alias', async () => {
  const skillHelp = await runCli(['skill', '--help']);
  assert.equal(skillHelp.code, 0, skillHelp.stderr);
  assert.match(skillHelp.stdout, /search \[options\] <query>/);

  const searchHelp = await runCli(['skill', 'search', '--help']);
  assert.equal(searchHelp.code, 0, searchHelp.stderr);
  assert.match(searchHelp.stdout, /--sort <sort>/);
  assert.match(searchHelp.stdout, /--curated/);
  assert.doesNotMatch(searchHelp.stdout, /--source|--on-chain|--chain/);

  const marketHelp = await runCli(['market', 'search', '--help']);
  assert.equal(marketHelp.code, 0, marketHelp.stderr);
  assert.match(marketHelp.stdout, /Legacy list alias with a broader default limit/);
  assert.match(marketHelp.stdout, /--chain <chainId>/);
});

test('invalid skill search input fails before making a request', async () => {
  const result = await runCli(['skill', 'search', '   ', '--json'], {
    FINCHIP_API_URL: 'http://127.0.0.1:1',
  });
  assert.equal(result.code, 3);
  assert.equal(JSON.parse(result.stdout).code, 'SEARCH_INVALID');
});
