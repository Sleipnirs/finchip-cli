import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

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

test('skill review help exposes list, submit, and delete commands', async () => {
  const result = await runCli(['skill', 'review', '--help']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /list \[options\] <slug>/);
  assert.match(result.stdout, /submit \[options\] <slug>/);
  assert.match(result.stdout, /delete \[options\] <slug>/);
});

test('skill review submit rejects invalid ratings before login or network access', async () => {
  const result = await runCli([
    'skill', 'review', 'submit', 'audit-pro-finchip',
    '--operational-independence', '6',
    '--output-quality', '4',
    '--model-compatibility', '5',
    '--body', 'This should fail locally.',
    '--json',
  ], {
    FINCHIP_API_URL: 'https://unreachable.invalid',
    FINCHIP_CREDENTIALS_PATH: 'Z:\\definitely-missing\\credentials.json',
  });

  assert.equal(result.code, 3);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'REVIEW_INVALID');
});
