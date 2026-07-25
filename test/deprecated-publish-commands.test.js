import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        FINCHIP_API_URL: 'http://127.0.0.1:1',
        FINCHIP_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      },
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

test('prepare and launch are hidden from root help while doctor and protocol remain', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^\s+prepare(?:\s|<|\[)/m);
  assert.doesNotMatch(result.stdout, /^\s+launch(?:\s|<|\[)/m);
  assert.match(result.stdout, /^\s+doctor(?:\s|<|\[)/m);
  assert.match(result.stdout, /^\s+protocol(?:\s|<|\[)/m);
});

for (const command of ['prepare', 'launch']) {
  test(`${command} returns COMMAND_DEPRECATED without using external services`, async () => {
    const result = await runCli([
      command,
      'nonexistent-source',
      '--chain',
      '56',
      '--unknown-legacy-option',
      'value',
      '--json',
    ]);
    assert.equal(result.code, 3, `${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, 'COMMAND_DEPRECATED');
    assert.match(payload.error, /finchip skill publish/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ECONNREFUSED|private key|IPFS/i);
  });
}

test('doctor and protocol command help remain callable', async () => {
  for (const command of ['doctor', 'protocol']) {
    const result = await runCli([command, '--help']);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  }
});
