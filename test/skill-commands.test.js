import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { saveOriginCredentials } from '../src/auth-client.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const TX_HASH = `0x${'ab'.repeat(32)}`;

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('skill publish is primary and the legacy publish alias remains hidden and compatible', async () => {
  const rootHelp = await runCli(['--help'], {});
  assert.equal(rootHelp.code, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /\bskill\b/);
  assert.doesNotMatch(rootHelp.stdout, /^\s+publish(?:\s|\[)/m);

  const skillHelp = await runCli(['skill', '--help'], {});
  assert.equal(skillHelp.code, 0, skillHelp.stderr);
  assert.match(skillHelp.stdout, /publish \[options\] \[path\]/);
  assert.match(skillHelp.stdout, /get \[options\] <slug>/);
  assert.match(skillHelp.stdout, /price/);

  const publishHelp = await runCli(['skill', 'publish', '--help'], {});
  assert.equal(publishHelp.code, 0, publishHelp.stderr);
  assert.match(publishHelp.stdout, /--resume <slug>/);
  assert.match(publishHelp.stdout, /--dry-run/);

  const legacyHelp = await runCli(['publish', '--help'], {});
  assert.equal(legacyHelp.code, 0, legacyHelp.stderr);
  assert.match(legacyHelp.stdout, /--resume <slug>/);

  const home = mkdtempSync(join(tmpdir(), 'finchip-skill-publish-alias-'));
  const env = { HOME: home, FINCHIP_CREDENTIALS_PATH: join(home, 'credentials.json') };
  const publishArgs = ['package.json', '--slug', 'demo', '--name', 'Demo', '--description', 'Test', '--price', '0.01', '--json'];
  const primary = await runCli(['skill', 'publish', ...publishArgs], env);
  const legacy = await runCli(['publish', ...publishArgs], env);
  assert.equal(primary.code, 2, `${primary.stderr}\n${primary.stdout}`);
  assert.equal(legacy.code, 2, `${legacy.stderr}\n${legacy.stdout}`);
  assert.deepEqual(JSON.parse(primary.stdout), JSON.parse(legacy.stdout));
});

test('skill get and price sync use creator manage endpoints with stable JSON', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ method: req.method, url: req.url, cookie: req.headers.cookie, origin: req.headers.origin, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/auth/session') {
        res.end(JSON.stringify({
          authenticated: true,
          wallet: { walletAddr: '0x2222222222222222222222222222222222222222' },
          identity: { userId: 'user-1', username: 'agent' },
          connections: { wallet: {}, github: null },
        }));
        return;
      }
      if (req.url === `/api/v2/skills/demo_finchip/manage?addr=${ADDR}&chainId=56`) {
        res.end(JSON.stringify({ skill: {
          id: 'skill-1', slug: 'demo_finchip', title: 'Demo', category: 'Code', is_on_chain: true,
          chip_address: ADDR, chain_id: 56, token_type: 'erc1155', price_wei: '10000000000000000',
        } }));
        return;
      }
      if (req.url === '/api/v2/skills/demo_finchip/manage/price/sync') {
        assert.deepEqual(body, { addr: ADDR, chainId: 56, txHash: TX_HASH });
        res.end(JSON.stringify({ priceWei: '20000000000000000', tokenType: 'erc1155', chipPrice: 0.02 }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-skill-command-'));
  const credentialsPath = join(root, 'credentials.json');
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
    finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
  }, { path: credentialsPath });
  const env = { FINCHIP_API_URL: origin, FINCHIP_CREDENTIALS_PATH: credentialsPath };
  try {
    const get = await runCli(['skill', 'get', 'demo_finchip', '--chain', '56', '--addr', ADDR, '--json'], env);
    assert.equal(get.code, 0, `${get.stderr}\n${get.stdout}`);
    assert.equal(JSON.parse(get.stdout).code, 'SKILL_FOUND');
    assert.doesNotMatch(get.stdout, /account-secret|wallet-secret/);

    const sync = await runCli(['skill', 'price', 'sync', 'demo_finchip', '--chain', '56', '--addr', ADDR, '--tx-hash', TX_HASH, '--json'], env);
    assert.equal(sync.code, 0, `${sync.stderr}\n${sync.stdout}`);
    assert.equal(JSON.parse(sync.stdout).code, 'PRICE_SYNCED');
    const syncRequest = requests.find(request => request.url?.endsWith('/manage/price/sync'));
    assert.equal(syncRequest.origin, origin);
    assert.match(syncRequest.cookie, /finchip_account_session=account-secret/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
