import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writePrivateBinaryFile } from '../src/private-files.js';
import { saveOriginCredentials } from '../src/auth-client.js';

const CHIP = '0x1111111111111111111111111111111111111111';

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

test('root download command exposes the stable options and rejects half a deployment before network access', async () => {
  const help = await runCli(['download', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /download \[options\] <slug>/);
  assert.match(help.stdout, /--chain <chainId>/);
  assert.match(help.stdout, /--addr <contract>/);
  assert.match(help.stdout, /--dir <directory>/);
  assert.match(help.stdout, /--force/);
  assert.match(help.stdout, /--no-provenance/);
  assert.match(help.stdout, /--json/);

  const invalid = await runCli(['download', 'demo_finchip', '--chain', '56', '--json'], {
    FINCHIP_API_URL: 'http://127.0.0.1:1',
  });
  assert.equal(invalid.code, 3, `${invalid.stderr}\n${invalid.stdout}`);
  assert.equal(JSON.parse(invalid.stdout).code, 'DOWNLOAD_DEPLOYMENT_REQUIRED');
});

test('private binary output is atomic, refuses overwrite, and is user-only on POSIX', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-download-output-'));
  const path = join(root, 'nested', 'skill.zip');
  writePrivateBinaryFile(path, Buffer.from('first'));
  assert.equal(readFileSync(path, 'utf8'), 'first');
  assert.equal(existsSync(`${path}.tmp`), false);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => writePrivateBinaryFile(path, Buffer.from('second')), /already exists/i);
  writePrivateBinaryFile(path, Buffer.from('second'), { force: true });
  assert.equal(readFileSync(path, 'utf8'), 'second');
});

test('plain download resolves the canonical deployment, uses cookie access, and emits stable JSON', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({ method: req.method, url: req.url, cookie: req.headers.cookie, body });
      if (req.url === '/api/auth/session') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          authenticated: true,
          wallet: { walletAddr: '0x2222222222222222222222222222222222222222' },
          identity: { userId: 'user-1' },
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          skill: { slug: 'demo_finchip', chip_address: CHIP, chain_id: 56 },
          v2: {},
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/source/manifest' && req.method === 'POST') {
        assert.deepEqual(body, { addr: CHIP, chainId: 56 });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          kind: 'ipfs_plain',
          files: [{ name: 'SKILL.md', path: 'ipfs://demo', encrypted: false }],
          packageDownloadUrl: '/api/v2/skills/demo-finchip/source?token=one-use',
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/source?token=one-use') {
        const content = Buffer.from('# downloaded\n');
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', 'attachment; filename="SKILL.md"');
        res.end(content);
        return;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-download-command-'));
  const credentialsPath = join(root, 'credentials.json');
  const outputDir = join(root, 'output');
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
    finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
  }, { path: credentialsPath });
  try {
    const result = await runCli(['download', 'demo_finchip', '--dir', outputDir, '--json'], {
      FINCHIP_API_URL: origin,
      FINCHIP_CREDENTIALS_PATH: credentialsPath,
      FINCHIP_PRIVATE_KEY: '',
    });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'DOWNLOAD_COMPLETE');
    assert.equal(payload.sourceKind, 'ipfs_plain');
    assert.equal(payload.integrityLevel, 'transport-only');
    assert.equal(payload.verifiedPlaintextSha256, null);
    assert.equal(readFileSync(payload.outputPath, 'utf8'), '# downloaded\n');
    assert.doesNotMatch(result.stdout, /account-secret|wallet-secret|one-use/);
    const manifestRequest = requests.find(request => request.url?.endsWith('/source/manifest'));
    assert.match(manifestRequest.cookie, /finchip_account_session=account-secret/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
