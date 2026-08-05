import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  FINCHIP_PROD_ORIGIN,
  assertNoPublicOriginOverride,
  parseFinchipTaskUrl,
} from '../src/site-origin.js';

function runPublishedCli(args) {
  const env = { ...process.env, FINCHIP_API_URL: 'https://evil.example' };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['bin/finchip.js', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
}

test('published CLI fixes wallet and authenticated traffic to the production origin', () => {
  assert.equal(FINCHIP_PROD_ORIGIN, 'https://finchip.ai');
  assert.doesNotThrow(() => assertNoPublicOriginOverride({}));
  assert.throws(
    () => assertNoPublicOriginOverride({ FINCHIP_API_URL: 'https://example.test' }),
    error => error.code === 'UNSUPPORTED_ORIGIN_OVERRIDE',
  );
});

test('published CLI allows help and version while origin override is set', () => {
  const version = runPublishedCli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.5.0');
  assert.doesNotMatch(version.stderr, /assertNoPublicOriginOverride|CliError/);

  const help = runPublishedCli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: finchip/);
  assert.doesNotMatch(help.stderr, /assertNoPublicOriginOverride|CliError/);
});

test('published CLI reports origin override through stable JSON and exit code', () => {
  for (const args of [
    ['wallet', 'status', '--json'],
    ['task', 'run', 'https://finchip.ai/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=secret_ABC-123', '--json'],
  ]) {
    const result = runPublishedCli(args);
    assert.equal(result.status, 3, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'UNSUPPORTED_ORIGIN_OVERRIDE');
    assert.doesNotMatch(result.stdout, /assertNoPublicOriginOverride|site-origin\.js:/);
  }
});

test('task URL is only a production request-id and fragment-secret carrier', () => {
  assert.deepEqual(
    parseFinchipTaskUrl('https://finchip.ai/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=secret_ABC-123'),
    {
      origin: 'https://finchip.ai',
      taskId: '123e4567-e89b-42d3-a456-426614174000',
      claimSecret: 'secret_ABC-123',
    },
  );

  for (const url of [
    'http://finchip.ai/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=x',
    'https://user@finchip.ai/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=x',
    'https://finchip.ai:444/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=x',
    'https://evil.example/agent-tasks/123e4567-e89b-42d3-a456-426614174000#claim=x',
    'https://finchip.ai/agent-tasks/not-a-uuid#claim=x',
    'https://finchip.ai/agent-tasks/123e4567-e89b-42d3-a456-426614174000',
  ]) {
    assert.throws(() => parseFinchipTaskUrl(url), error => error.code === 'TASK_ORIGIN_MISMATCH' || error.code === 'TASK_INVALID');
  }
});
