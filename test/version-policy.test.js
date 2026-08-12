import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLI_VERSION_POLICY_CACHE_TTL_MS,
  CLI_VERSION_POLICY_FAILURE_TTL_MS,
  checkCliVersionPolicy,
  compareCliVersions,
  isCliVersionSupported,
} from '../src/version-policy.js';

const policy = {
  schemaVersion: 1,
  minimumSupportedVersion: '0.5.2',
  recommendedVersion: '0.5.3',
  updateCommand: 'npm install --global finchip-cli@latest',
  releaseUrl: 'https://github.com/Sleipnirs/finchip-cli/releases/latest',
};

function tempCachePath() {
  return join(mkdtempSync(join(tmpdir(), 'finchip-version-policy-')), 'version-policy.json');
}

test('CLI version comparison is numeric and rejects malformed versions', () => {
  assert.equal(compareCliVersions('0.5.2', '0.5.2'), 0);
  assert.equal(compareCliVersions('0.5.10', '0.5.3'), 1);
  assert.equal(compareCliVersions('0.5.1', '0.5.2'), -1);
  assert.equal(compareCliVersions('not-semver', '0.5.2'), null);
  assert.equal(isCliVersionSupported('0.6.0', '0.5.2'), true);
  assert.equal(isCliVersionSupported('0.7.0', '0.6.0'), true);
  assert.equal(isCliVersionSupported('0.5.1', '0.5.2'), false);
  assert.equal(isCliVersionSupported('0.6.0', '0.6.0'), true);
  assert.equal(isCliVersionSupported('1.0.0', '0.6.0'), false);
  assert.equal(isCliVersionSupported('abc', '0.6.0'), false);
});

test('fresh cached policy produces a required update warning without network access', async () => {
  const cachePath = tempCachePath();
  writeFileSync(cachePath, JSON.stringify({ schemaVersion: 1, fetchedAt: '2026-08-05T12:00:00.000Z', policy }));
  let fetched = false;
  const result = await checkCliVersionPolicy({
    currentVersion: '0.5.1',
    cachePath,
    now: Date.parse('2026-08-05T12:05:00.000Z'),
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });

  assert.equal(fetched, false);
  assert.equal(result.source, 'cache');
  assert.deepEqual(result.warning, {
    code: 'CLI_UPDATE_REQUIRED',
    severity: 'required',
    currentVersion: '0.5.1',
    minimumSupportedVersion: '0.5.2',
    recommendedVersion: '0.5.3',
    updateCommand: policy.updateCommand,
    releaseUrl: policy.releaseUrl,
  });
});

test('stale policy refresh is bounded, validated, and cached', async () => {
  const cachePath = tempCachePath();
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const result = await checkCliVersionPolicy({
    currentVersion: '0.5.2',
    cachePath,
    now,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://finchip.ai/api/cli/version-policy');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify({ ok: true, ...policy }), { status: 200 });
    },
  });

  assert.equal(result.source, 'network');
  assert.equal(result.warning.code, 'CLI_UPDATE_AVAILABLE');
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  assert.equal(cached.fetchedAt, new Date(now).toISOString());
  assert.equal(cached.refreshFailed, false);
  assert.deepEqual(cached.policy, policy);
});

test('failed refresh retains a stale warning but retries after the one-hour failure TTL', async () => {
  const cachePath = tempCachePath();
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  writeFileSync(cachePath, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: new Date(now - CLI_VERSION_POLICY_CACHE_TTL_MS - 1).toISOString(),
    refreshFailed: false,
    policy,
  }));
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount += 1; throw new Error('offline'); };

  const stale = await checkCliVersionPolicy({ currentVersion: '0.5.2', cachePath, now, fetchImpl });
  assert.equal(stale.source, 'stale-cache');
  assert.equal(stale.warning.code, 'CLI_UPDATE_AVAILABLE');
  assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).refreshFailed, true);

  const cachedFailure = await checkCliVersionPolicy({ currentVersion: '0.5.2', cachePath, now: now + 30 * 60_000, fetchImpl });
  assert.equal(cachedFailure.source, 'cache');
  assert.equal(fetchCount, 1);

  await checkCliVersionPolicy({ currentVersion: '0.5.2', cachePath, now: now + CLI_VERSION_POLICY_FAILURE_TTL_MS + 1, fetchImpl });
  assert.equal(fetchCount, 2);
});

test('network and cache failures never fail the requested CLI command', async () => {
  const result = await checkCliVersionPolicy({
    currentVersion: '0.5.2',
    cachePath: tempCachePath(),
    now: Date.now() + CLI_VERSION_POLICY_CACHE_TTL_MS,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(result, { source: 'unavailable', warning: null });
});

test('cached update policy warns on every command without corrupting JSON stdout', () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-version-policy-home-'));
  const configDirectory = join(home, '.finchip');
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(join(configDirectory, 'version-policy.json'), JSON.stringify({
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    policy: { ...policy, minimumSupportedVersion: '0.6.3', recommendedVersion: '0.6.3' },
  }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.FINCHIP_API_URL;
  delete env.NODE_OPTIONS;

  const jsonResult = spawnSync(process.execPath, ['bin/finchip.js', 'status', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  });
  assert.equal(jsonResult.status, 2, `${jsonResult.stderr}\n${jsonResult.stdout}`);
  assert.equal(jsonResult.stderr, '');
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.warnings?.[0]?.code, 'CLI_UPDATE_REQUIRED');

  const textResult = spawnSync(process.execPath, ['bin/finchip.js', 'status'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  });
  assert.equal(textResult.status, 2, `${textResult.stderr}\n${textResult.stdout}`);
  assert.match(textResult.stderr, /\[FinChip\] Update required: installed 0\.6\.2; recommended 0\.6\.3/);
});
