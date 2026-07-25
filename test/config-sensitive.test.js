import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOME: home, USERPROFILE: home },
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

test('legacy pinataJwt remains masked even though publish no longer reads it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-config-sensitive-'));
  const secret = 'legacy-pinata-secret';
  const set = await runCli(['config', 'set', 'pinataJwt', secret], home);
  assert.equal(set.code, 0, set.stderr);
  assert.doesNotMatch(set.stdout, new RegExp(secret));

  const get = await runCli(['config', 'get', 'pinataJwt'], home);
  assert.equal(get.code, 0, get.stderr);
  assert.doesNotMatch(get.stdout, new RegExp(secret));
  assert.match(get.stdout, /set/i);
});
