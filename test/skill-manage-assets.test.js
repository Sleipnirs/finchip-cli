import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { saveOriginCredentials } from '../src/auth-client.js';
import { loadImageUpload, loadPageUpload } from '../src/manage-assets.js';

const ADDR = '0x1111111111111111111111111111111111111111';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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

test('image upload validates extension, MIME inference, magic bytes, and size', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-image-'));
  const image = join(root, 'cover.png');
  writeFileSync(image, PNG);
  const loaded = loadImageUpload(image);
  assert.equal(loaded.name, 'cover.png');
  assert.equal(loaded.mime, 'image/png');
  assert.deepEqual(loaded.bytes, PNG);

  const mismatch = join(root, 'cover.jpg');
  writeFileSync(mismatch, PNG);
  assert.throws(() => loadImageUpload(mismatch), error => error.code === 'MANAGE_INVALID' && /magic/i.test(error.message));

  const oversized = join(root, 'large.png');
  writeFileSync(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => loadImageUpload(oversized), error => error.code === 'MANAGE_UPLOAD_TOO_LARGE');
});

test('HTML package accepts flat assets and rejects active or nested content', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-page-'));
  const assets = join(root, 'assets');
  mkdirSync(assets);
  writeFileSync(join(assets, 'diagram.png'), PNG);
  const html = join(root, 'instruction.html');
  writeFileSync(html, '<h1>Guide</h1><img src="./assets/diagram.png">');
  const loaded = loadPageUpload('instruction', html, assets);
  assert.equal(loaded.field, 'instruction');
  assert.equal(loaded.assets.length, 1);
  assert.equal(loaded.assets[0].name, 'diagram.png');

  writeFileSync(html, '<script>alert(1)</script>');
  assert.throws(() => loadPageUpload('instruction', html, assets), error => error.code === 'MANAGE_INVALID');
  writeFileSync(html, '<img src="./assets/nested/file.png">');
  assert.throws(() => loadPageUpload('instruction', html, assets), error => error.code === 'MANAGE_INVALID');
  writeFileSync(html, '<img src="/private.png">');
  assert.throws(() => loadPageUpload('instruction', html, assets), error => error.code === 'MANAGE_INVALID');
  writeFileSync(html, '<h1>safe</h1>');
  writeFileSync(join(assets, 'payload.js'), 'alert(1)');
  assert.throws(() => loadPageUpload('instruction', html, assets), error => error.code === 'MANAGE_INVALID');
});

test('image and page commands require confirmation only for destructive writes', async () => {
  const requests = [];
  let imagePath = 'skills/skill-1/display/old.png';
  let instructionManifest = { mode: 'html', hash: 'old' };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        contentType: req.headers['content-type'],
        raw,
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
      if (req.url === `/api/v2/skills/demo-finchip/manage?addr=${ADDR}&chainId=56` && req.method === 'GET') {
        res.end(JSON.stringify({
          skill: {
            id: 'skill-1',
            slug: 'demo_finchip',
            chip_address: ADDR,
            chain_id: 56,
            display_overrides: { imagePath },
            instruction_manifest: instructionManifest,
          },
          supportedAgents: [],
          relatedSkills: [],
        }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/manage/image' && req.method === 'POST') {
        imagePath = 'skills/skill-1/display/new.png';
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.match(raw.toString('latin1'), /name="image"; filename="cover.png"/);
        assert.match(raw.toString('latin1'), /name="addr"/);
        assert.doesNotMatch(raw.toString('latin1'), /wallet_addr|signature/);
        res.end(JSON.stringify({ imagePath, displayOverrides: { imagePath } }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/manage/instruction' && req.method === 'POST') {
        instructionManifest = { mode: 'html', hash: 'new' };
        const multipart = raw.toString('latin1');
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.match(multipart, /name="instruction"; filename="instruction.html"/);
        assert.match(multipart, /name="assets"; filename="diagram.png"/);
        assert.match(multipart, /name="addr"/);
        assert.doesNotMatch(multipart, /wallet_addr|signature/);
        res.end(JSON.stringify({ manifest: instructionManifest }));
        return;
      }
      if (req.url === '/api/v2/skills/demo-finchip/manage/instruction' && req.method === 'DELETE') {
        instructionManifest = null;
        res.end(JSON.stringify({ manifest: null }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'finchip-assets-command-'));
  const credentialsPath = join(root, 'credentials.json');
  const image = join(root, 'cover.png');
  const html = join(root, 'instruction.html');
  const assets = join(root, 'assets');
  writeFileSync(image, PNG);
  writeFileSync(html, '<h1>Guide</h1><img src="./assets/diagram.png">');
  mkdirSync(assets);
  writeFileSync(join(assets, 'diagram.png'), PNG);
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
  }, { path: credentialsPath });
  const env = { FINCHIP_API_URL: origin, FINCHIP_CREDENTIALS_PATH: credentialsPath };
  try {
    const refused = await runCli([
      'skill', 'manage', 'image', 'set', 'demo_finchip', '--file', image,
      '--chain', '56', '--addr', ADDR, '--json',
    ], env);
    assert.equal(refused.code, 3, `${refused.stderr}\n${refused.stdout}`);
    assert.equal(JSON.parse(refused.stdout).code, 'MANAGE_CONFIRM_REQUIRED');
    assert.equal(requests.some(request => request.method === 'POST'), false);

    const dryRun = await runCli([
      'skill', 'manage', 'image', 'set', 'demo_finchip', '--file', image,
      '--chain', '56', '--addr', ADDR, '--dry-run', '--json',
    ], env);
    assert.equal(dryRun.code, 0, `${dryRun.stderr}\n${dryRun.stdout}`);
    assert.equal(JSON.parse(dryRun.stdout).code, 'SKILL_IMAGE_DRY_RUN');

    const uploaded = await runCli([
      'skill', 'manage', 'image', 'set', 'demo_finchip', '--file', image,
      '--chain', '56', '--addr', ADDR, '--yes', '--json',
    ], env);
    assert.equal(uploaded.code, 0, `${uploaded.stderr}\n${uploaded.stdout}`);
    assert.equal(JSON.parse(uploaded.stdout).code, 'SKILL_IMAGE_UPDATED');

    const pageUploaded = await runCli([
      'skill', 'manage', 'page', 'upload', 'demo_finchip',
      '--kind', 'instruction', '--html', html, '--assets-dir', assets,
      '--chain', '56', '--addr', ADDR, '--yes', '--json',
    ], env);
    assert.equal(pageUploaded.code, 0, `${pageUploaded.stderr}\n${pageUploaded.stdout}`);
    assert.equal(JSON.parse(pageUploaded.stdout).code, 'SKILL_PAGE_UPLOADED');

    const restoreDryRun = await runCli([
      'skill', 'manage', 'page', 'restore', 'demo_finchip', '--kind', 'instruction',
      '--chain', '56', '--addr', ADDR, '--dry-run', '--json',
    ], env);
    assert.equal(restoreDryRun.code, 0, `${restoreDryRun.stderr}\n${restoreDryRun.stdout}`);
    assert.equal(JSON.parse(restoreDryRun.stdout).code, 'SKILL_PAGE_RESTORE_DRY_RUN');

    const restoreRefused = await runCli([
      'skill', 'manage', 'page', 'restore', 'demo_finchip', '--kind', 'instruction',
      '--chain', '56', '--addr', ADDR, '--json',
    ], env);
    assert.equal(restoreRefused.code, 3, `${restoreRefused.stderr}\n${restoreRefused.stdout}`);
    assert.equal(JSON.parse(restoreRefused.stdout).code, 'MANAGE_CONFIRM_REQUIRED');

    const restored = await runCli([
      'skill', 'manage', 'page', 'restore', 'demo_finchip', '--kind', 'instruction',
      '--chain', '56', '--addr', ADDR, '--yes', '--json',
    ], env);
    assert.equal(restored.code, 0, `${restored.stderr}\n${restored.stdout}`);
    assert.equal(JSON.parse(restored.stdout).code, 'SKILL_PAGE_RESTORED');
    const deleteRequest = requests.find(request => request.method === 'DELETE');
    assert.deepEqual(JSON.parse(deleteRequest.raw.toString('utf8')), { addr: ADDR, chainId: 56 });
    assert.match(deleteRequest.cookie, /account-secret/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('page upload sends one HTML file and flat assets with stable fields', async () => {
  const help = await runCli(['skill', 'manage', 'page', 'upload', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--kind <kind>/);
  assert.match(help.stdout, /--html <file>/);
  assert.match(help.stdout, /--assets-dir <directory>/);
  assert.match(help.stdout, /--yes/);
});
