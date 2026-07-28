import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { loadOriginCredentials, saveOriginCredentials } from '../src/auth-client.js';

const LEGACY_KEY = `0x${'55'.repeat(32)}`;
const OTHER_KEY = `0x${'66'.repeat(32)}`;

function runCli(args, home, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FINCHIP_PRIVATE_KEY: '',
        FINCHIP_PRIVATE_KEY_FILE: '',
        ...extraEnv,
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('wallet create, status, and existing-target refusal never reveal or replace the key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-create-'));
  const created = await runCli(['wallet', 'create', '--json'], home);
  assert.equal(created.code, 0, created.stderr);
  const result = JSON.parse(created.stdout);
  assert.equal(result.code, 'WALLET_CREATED');
  assert.match(result.address, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(result.path.endsWith(join('.finchip', 'wallets', 'agent.key')));

  const stored = readFileSync(result.path, 'utf8').trim();
  assert.equal(privateKeyToAccount(stored).address, result.address);
  assert.doesNotMatch(created.stdout + created.stderr, new RegExp(stored.slice(2), 'i'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(result.path)).mode & 0o777, 0o700);
  }

  const status = await runCli(['wallet', 'status', '--json'], home);
  assert.equal(status.code, 0, status.stderr);
  const statusResult = JSON.parse(status.stdout);
  assert.equal(statusResult.code, 'WALLET_STATUS');
  assert.equal(statusResult.address, result.address);
  assert.equal(statusResult.source, 'config-file');

  const second = await runCli(['wallet', 'create', '--json'], home);
  assert.equal(second.code, 3);
  assert.equal(JSON.parse(second.stdout).code, 'WALLET_FILE_EXISTS');
  assert.equal(readFileSync(result.path, 'utf8').trim(), stored);
});

test('wallet create text output reports only the public wallet material', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-create-text-'));
  const created = await runCli(['wallet', 'create'], home);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Created and selected a dedicated Agent wallet/);
  assert.match(created.stdout, /unencrypted private key/i);
  assert.doesNotMatch(created.stdout + created.stderr, /ReferenceError|undefined/);
});

test('wallet use selects a user-provided key file without copying it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-use-'));
  const externalDir = mkdtempSync(join(tmpdir(), 'finchip-external-wallet-'));
  const externalPath = join(externalDir, 'provided.key');
  writeFileSync(externalPath, `${LEGACY_KEY.slice(2)}\n`);
  if (process.platform !== 'win32') chmodSync(externalPath, 0o644);
  const before = readFileSync(externalPath, 'utf8');
  const modeBefore = process.platform === 'win32' ? null : statSync(externalPath).mode & 0o777;

  const selected = await runCli(['wallet', 'use', '--file', externalPath, '--json'], home);
  assert.equal(selected.code, 0, selected.stderr);
  const result = JSON.parse(selected.stdout);
  assert.equal(result.code, 'WALLET_SELECTED');
  assert.equal(result.path, externalPath);
  assert.equal(result.address, privateKeyToAccount(LEGACY_KEY).address);
  assert.equal(readFileSync(externalPath, 'utf8'), before);
  if (process.platform !== 'win32') {
    assert.equal(statSync(externalPath).mode & 0o777, modeBefore);
  }
});

test('wallet status and use report deprecated environment variables without being blocked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-deprecated-env-'));
  const currentPath = join(home, 'current.key');
  const nextPath = join(home, 'next.key');
  writeFileSync(currentPath, `${LEGACY_KEY}\n`);
  writeFileSync(nextPath, `${OTHER_KEY}\n`);
  mkdirSync(join(home, '.finchip'), { recursive: true });
  writeFileSync(join(home, '.finchip', 'config.json'), JSON.stringify({
    privateKeyFile: currentPath,
    wallet: privateKeyToAccount(LEGACY_KEY).address,
  }, null, 2));

  const staleRawKey = `0x${'77'.repeat(32)}`;
  const status = await runCli(
    ['wallet', 'status', '--json'],
    home,
    { FINCHIP_PRIVATE_KEY: staleRawKey },
  );
  assert.equal(status.code, 0, `${status.stderr}\n${status.stdout}`);
  const statusResult = JSON.parse(status.stdout);
  assert.equal(statusResult.address, privateKeyToAccount(LEGACY_KEY).address);
  assert.equal(statusResult.ready, false);
  assert.deepEqual(statusResult.blockedBy, ['FINCHIP_PRIVATE_KEY']);
  assert.doesNotMatch(status.stdout + status.stderr, new RegExp(staleRawKey.slice(2), 'i'));

  const selected = await runCli(
    ['wallet', 'use', '--file', nextPath, '--json'],
    home,
    { FINCHIP_PRIVATE_KEY_FILE: 'stale-agent.key' },
  );
  assert.equal(selected.code, 0, `${selected.stderr}\n${selected.stdout}`);
  const selectedResult = JSON.parse(selected.stdout);
  assert.equal(selectedResult.address, privateKeyToAccount(OTHER_KEY).address);
  assert.equal(selectedResult.ready, false);
  assert.deepEqual(selectedResult.blockedBy, ['FINCHIP_PRIVATE_KEY_FILE']);
  assert.equal(JSON.parse(readFileSync(join(home, '.finchip', 'config.json'), 'utf8')).privateKeyFile, nextPath);

  const blockedLogin = await runCli(
    ['login', '--json'],
    home,
    { FINCHIP_PRIVATE_KEY: staleRawKey },
  );
  assert.equal(blockedLogin.code, 3);
  const blockedResult = JSON.parse(blockedLogin.stdout);
  assert.equal(blockedResult.code, 'WALLET_ENV_DISABLED');
  assert.match(blockedResult.error, /deprecated and disabled/);
  assert.match(blockedResult.error, /Remove the deprecated environment variable/);
  assert.doesNotMatch(blockedLogin.stdout + blockedLogin.stderr, new RegExp(staleRawKey.slice(2), 'i'));
});

test('wallet use logs out a persisted session belonging to a different wallet', async () => {
  const oldAddress = privateKeyToAccount(LEGACY_KEY).address;
  const newAddress = privateKeyToAccount(OTHER_KEY).address;
  let activeSessionWallet = oldAddress;
  let logoutCalls = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/session' && req.method === 'GET') {
      res.end(JSON.stringify({
        authenticated: true,
        identity: { userId: 'user-1', walletAddr: activeSessionWallet },
        account: { userId: 'user-1' },
        wallet: { walletAddr: activeSessionWallet },
        connections: { wallet: { walletAddr: activeSessionWallet }, github: null },
      }));
      return;
    }
    if (req.url === '/api/auth/logout' && req.method === 'POST') {
      logoutCalls += 1;
      res.setHeader('Set-Cookie', [
        'finchip_account_session=; Max-Age=0; HttpOnly; Path=/',
        'finchip_wallet_session=; Max-Age=0; HttpOnly; Path=/',
      ]);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-switch-session-'));
  const credentialsPath = join(home, 'credentials.json');
  const newWalletPath = join(home, 'new-wallet.key');
  writeFileSync(newWalletPath, `${OTHER_KEY}\n`);
  saveOriginCredentials(origin, {
    finchip_account_session: { value: 'account-secret', expiresAt: null },
    finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
  }, { path: credentialsPath });

  try {
    const selected = await runCli(
      ['wallet', 'use', '--file', newWalletPath, '--json'],
      home,
      {
        FINCHIP_API_URL: origin,
        FINCHIP_CREDENTIALS_PATH: credentialsPath,
      },
    );
    assert.equal(selected.code, 0, `${selected.stderr}\n${selected.stdout}`);
    const result = JSON.parse(selected.stdout);
    assert.equal(result.code, 'WALLET_SELECTED');
    assert.equal(result.address, newAddress);
    assert.equal(result.sessionAction, 'logged-out');
    assert.equal(result.previousSessionWallet, oldAddress);
    assert.equal(result.remoteRevoked, true);
    assert.equal(logoutCalls, 1);
    assert.deepEqual(loadOriginCredentials(origin, { path: credentialsPath }), {});

    activeSessionWallet = newAddress;
    saveOriginCredentials(origin, {
      finchip_account_session: { value: 'account-secret', expiresAt: null },
      finchip_wallet_session: { value: 'wallet-secret', expiresAt: null },
    }, { path: credentialsPath });
    const repeated = await runCli(
      ['wallet', 'use', '--file', newWalletPath, '--json'],
      home,
      {
        FINCHIP_API_URL: origin,
        FINCHIP_CREDENTIALS_PATH: credentialsPath,
      },
    );
    assert.equal(repeated.code, 0, `${repeated.stderr}\n${repeated.stdout}`);
    const repeatedResult = JSON.parse(repeated.stdout);
    assert.equal(repeatedResult.sessionAction, 'preserved');
    assert.equal(repeatedResult.previousSessionWallet, newAddress);
    assert.equal(repeatedResult.remoteRevoked, null);
    assert.equal(logoutCalls, 1);
    assert.notDeepEqual(loadOriginCredentials(origin, { path: credentialsPath }), {});
  } finally {
    await close(server);
  }
});

test('wallet migrate is resumable for the same address and refuses a different existing wallet', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-migrate-'));
  const configPath = join(home, '.finchip', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ privateKey: LEGACY_KEY, chain: 56 }, null, 2));

  const target = join(home, 'legacy-agent.key');
  const migrated = await runCli(['wallet', 'migrate', '--file', target, '--json'], home);
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).code, 'WALLET_MIGRATED');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.privateKey, undefined);
  assert.equal(config.privateKeyFile, target);
  assert.equal(config.wallet, privateKeyToAccount(LEGACY_KEY).address);

  // Re-create a legacy field to model a config write that previously failed.
  config.privateKey = LEGACY_KEY;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const resumed = await runCli(['wallet', 'migrate', '--file', target, '--json'], home);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reusedExistingFile, true);

  const conflictingHome = mkdtempSync(join(tmpdir(), 'finchip-wallet-migrate-conflict-'));
  const conflictingConfig = join(conflictingHome, '.finchip', 'config.json');
  mkdirSync(dirname(conflictingConfig), { recursive: true });
  writeFileSync(conflictingConfig, JSON.stringify({ privateKey: LEGACY_KEY }, null, 2));
  const conflictTarget = join(conflictingHome, 'occupied.key');
  writeFileSync(conflictTarget, `0x${'66'.repeat(32)}\n`);
  const conflict = await runCli(['wallet', 'migrate', '--file', conflictTarget, '--json'], conflictingHome);
  assert.equal(conflict.code, 3);
  assert.equal(JSON.parse(conflict.stdout).code, 'WALLET_FILE_EXISTS');
  assert.equal(JSON.parse(readFileSync(conflictingConfig, 'utf8')).privateKey, LEGACY_KEY);
});

test('config refuses both direct private key settings before writing them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-config-refusal-'));
  const raw = await runCli(['config', 'set', 'privateKey', LEGACY_KEY, '--json'], home);
  assert.equal(raw.code, 3);
  assert.equal(JSON.parse(raw.stdout).code, 'PRIVATE_KEY_CONFIG_DISABLED');
  assert.doesNotMatch(raw.stdout + raw.stderr, new RegExp(LEGACY_KEY.slice(2), 'i'));

  const file = await runCli(['config', 'set', 'privateKeyFile', 'some.key', '--json'], home);
  assert.equal(file.code, 3);
  assert.equal(JSON.parse(file.stdout).code, 'PRIVATE_KEY_CONFIG_DISABLED');

  const rawText = await runCli(['config', 'set', 'privateKey', LEGACY_KEY], home);
  assert.equal(rawText.code, 3);
  assert.match(rawText.stderr, /\[PRIVATE_KEY_CONFIG_DISABLED\]/);
  assert.doesNotMatch(rawText.stdout + rawText.stderr, new RegExp(LEGACY_KEY.slice(2), 'i'));

  const fileText = await runCli(['config', 'set', 'privateKeyFile', 'some.key'], home);
  assert.equal(fileText.code, 3);
  assert.match(fileText.stderr, /\[PRIVATE_KEY_CONFIG_DISABLED\]/);
});

test('missing wallets return stable errors without loading network commands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'finchip-wallet-missing-'));

  const status = await runCli(['wallet', 'status', '--json'], home);
  assert.equal(status.code, 3);
  assert.equal(JSON.parse(status.stdout).code, 'WALLET_KEY_MISSING');

  const login = await runCli(['login', '--json'], home);
  assert.equal(login.code, 3);
  assert.equal(JSON.parse(login.stdout).code, 'WALLET_KEY_MISSING');
  assert.doesNotMatch(login.stderr, /SyntaxError|at file:/);

  const library = await runCli(['library'], home);
  assert.equal(library.code, 3);
  assert.match(library.stderr, /\[WALLET_KEY_MISSING\]/);
  assert.doesNotMatch(library.stderr, /at file:/);
});
