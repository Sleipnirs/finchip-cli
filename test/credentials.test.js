import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  loadOriginCredentials,
  normalizeApiOrigin,
  readCredentialStore,
  saveOriginCredentials,
} from '../src/auth-client.js';

test('credentials are isolated by normalized API origin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-credentials-'));
  const path = join(dir, 'credentials.json');
  const prod = normalizeApiOrigin('https://finchip.ai/some/path');
  const local = normalizeApiOrigin('http://localhost:3000/api');

  saveOriginCredentials(prod, { finchip_account_session: { value: 'prod', expiresAt: null } }, { path });
  saveOriginCredentials(local, { finchip_account_session: { value: 'local', expiresAt: null } }, { path });

  assert.equal(loadOriginCredentials(prod, { path }).finchip_account_session.value, 'prod');
  assert.equal(loadOriginCredentials(local, { path }).finchip_account_session.value, 'local');
});

test('credentials file uses owner-only permissions and valid versioned JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-mode-'));
  const path = join(root, 'nested', 'credentials.json');
  saveOriginCredentials('https://finchip.ai', {
    finchip_wallet_session: { value: 'secret', expiresAt: null },
  }, { path });

  if (process.platform === 'win32') {
    // POSIX mode bits are not enforced on Windows; owner-only access is
    // granted via ACL (icacls) instead. Assert the ACL was tightened.
    const probe = spawnSync('icacls', [path], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(probe.stdout.includes(`${process.env.USERNAME}:`), probe.stdout);
  } else {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, 'nested')).mode & 0o777, 0o700);
  }
  assert.equal(readCredentialStore(path).version, 1);
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
});

test('expired cookies are removed when credentials load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-expiry-'));
  const path = join(dir, 'credentials.json');
  saveOriginCredentials('https://finchip.ai', {
    finchip_account_session: { value: 'expired', expiresAt: 99 },
    finchip_wallet_session: { value: 'valid', expiresAt: 200 },
  }, { path, now: 1 });

  const cookies = loadOriginCredentials('https://finchip.ai', { path, now: 100 });
  assert.deepEqual(Object.keys(cookies), ['finchip_wallet_session']);
  assert.equal(cookies.finchip_wallet_session.value, 'valid');
});

test('plain HTTP origins are rejected outside localhost', () => {
  assert.equal(normalizeApiOrigin('http://localhost:3000/api'), 'http://localhost:3000');
  assert.equal(normalizeApiOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeApiOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  assert.equal(normalizeApiOrigin('https://finchip.ai'), 'https://finchip.ai');
  assert.throws(() => normalizeApiOrigin('http://finchip.ai'), /must use HTTPS/);
  assert.throws(() => normalizeApiOrigin('http://192.168.1.10:3000'), /must use HTTPS/);
});

test('corrupt credentials fail closed without exposing file content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-corrupt-'));
  const path = join(dir, 'credentials.json');
  saveOriginCredentials('https://finchip.ai', {
    finchip_account_session: { value: 'secret', expiresAt: null },
  }, { path });
  writeFileSync(path, '{not-json', 'utf8');
  assert.deepEqual(readCredentialStore(path), { version: 1, profiles: {} });
});
