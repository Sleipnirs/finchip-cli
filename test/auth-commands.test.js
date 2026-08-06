import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadOriginCredentials, saveOriginCredentials } from '../src/auth-client.js';

const PRIVATE_KEY = `0x${'1'.padStart(64, '0')}`;
const WALLET_ADDR = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

function runCli(args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    let confirmationStarted = false;
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (options.confirmLocal && !confirmationStarted) {
        const match = stderr.match(/(http:\/\/127\.0\.0\.1:\d+\/confirm\/[A-Za-z0-9_-]+)/);
        if (match) {
          confirmationStarted = true;
          void fetch(match[1], { method: 'POST', redirect: 'manual' }).catch(reject);
        }
      }
    });
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

test('login, status, repeated login, and logout complete the cookie lifecycle', async () => {
  let authenticated = false;
  let observedOrigin = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/api/auth/cli-login/requests' && req.method === 'POST') {
        observedOrigin = req.headers.origin;
        res.setHeader('Set-Cookie', 'finchip_cli_login_pending=pending; Max-Age=600; HttpOnly; Path=/');
        res.end(JSON.stringify({ taskUrl: `${origin}/agent-tasks/11111111-1111-4111-8111-111111111111#claim=claim-secret`, requestId: '11111111-1111-4111-8111-111111111111' }));
        return;
      }
      if (req.url === '/api/auth/cli-login/requests/11111111-1111-4111-8111-111111111111/claim' && req.method === 'POST') {
        assert.equal(body.walletAddr, WALLET_ADDR);
        assert.equal(body.cliVersion, '0.6.0');
        res.end(JSON.stringify({ ok: true, message: 'FinChip test Agent login challenge' }));
        return;
      }
      if (req.url === '/api/auth/cli-login/requests/11111111-1111-4111-8111-111111111111/authorize' && req.method === 'POST') {
        assert.equal(typeof body.signature, 'string');
        assert.ok(body.signature.startsWith('0x'));
        authenticated = true;
        res.setHeader('Set-Cookie', [
          'finchip_account_session=account-secret; Max-Age=3600; HttpOnly; Path=/',
          'finchip_wallet_session=wallet-secret; Max-Age=3600; HttpOnly; Path=/',
        ]);
        res.end(JSON.stringify({ ok: true, userId: 'user-1', walletAddr: WALLET_ADDR, handoffUrl: `${origin}/auth/agent/complete#handoff=browser-secret` }));
        return;
      }
      if (req.url === '/api/auth/session' && req.method === 'GET') {
        const hasCookies = /finchip_account_session=account-secret/.test(req.headers.cookie || '')
          && /finchip_wallet_session=wallet-secret/.test(req.headers.cookie || '');
        if (!authenticated || !hasCookies) {
          res.end(JSON.stringify({ authenticated: false, identity: null, account: null, wallet: null, connections: { wallet: null, github: null } }));
          return;
        }
        const loginBody = {
          authenticated: true,
          authMode: 'agent_cli',
          identity: { userId: 'user-1', username: 'agent_user', walletAddr: body.wallet_addr },
          account: { userId: 'user-1', clientKind: 'cli', authMode: 'agent_cli' },
          wallet: { walletAddr: WALLET_ADDR, clientKind: 'cli', authMode: 'agent_cli' },
          connections: {
            wallet: { walletAddr: WALLET_ADDR, signatureKind: 'eoa', verifiedChainIds: [56] },
            github: null,
          },
        };
        res.end(JSON.stringify(loginBody));
        return;
      }
      if (req.url === '/api/auth/logout' && req.method === 'POST') {
        observedOrigin = req.headers.origin;
        authenticated = false;
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
  });

  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'finchip-auth-command-'));
  const walletPath = join(dir, 'agent.key');
  writeFileSync(walletPath, `${PRIVATE_KEY}\n`);
  mkdirSync(join(dir, '.finchip'), { recursive: true });
  writeFileSync(join(dir, '.finchip', 'config.json'), JSON.stringify({
    privateKeyFile: walletPath,
    wallet: WALLET_ADDR,
    chain: 56,
  }, null, 2));
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    FINCHIP_API_URL: origin,
    FINCHIP_CREDENTIALS_PATH: join(dir, 'credentials.json'),
    FINCHIP_PRIVATE_KEY: '',
    FINCHIP_PRIVATE_KEY_FILE: '',
  };

  try {
    const login = await runCli(['login', '--json'], env, { confirmLocal: true });
    assert.equal(login.code, 0, `${login.stderr}\n${login.stdout}`);
    const loginJson = JSON.parse(login.stdout);
    assert.equal(loginJson.code, 'AUTHENTICATED');
    assert.equal(loginJson.account.walletAddr, WALLET_ADDR);
    assert.doesNotMatch(login.stdout, /account-secret|wallet-secret|claim-secret|browser-secret/);
    assert.equal(observedOrigin, origin);

    const status = await runCli(['status', '--json'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).authenticated, true);

    const repeated = await runCli(['login', '--json'], env);
    assert.equal(repeated.code, 3);
    assert.equal(JSON.parse(repeated.stdout).code, 'AUTH_ALREADY_ACTIVE');

    const logout = await runCli(['logout', '--json'], env);
    assert.equal(logout.code, 0, logout.stderr);
    assert.equal(JSON.parse(logout.stdout).code, 'LOGGED_OUT');
    assert.equal(observedOrigin, origin);

    const afterLogout = await runCli(['status', '--json'], env);
    assert.equal(afterLogout.code, 2);
    assert.equal(JSON.parse(afterLogout.stdout).code, 'SESSION_REAUTH_REQUIRED');
  } finally {
    await close(server);
  }
});

test('logout clears local credentials even when remote revocation fails', async () => {
  let logoutCalls = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/session' && req.method === 'GET') {
      res.end(JSON.stringify({
        authenticated: true,
        identity: { userId: 'user-1', username: 'agent_user' },
      account: { userId: 'user-1', clientKind: 'cli' },
      wallet: { walletAddr: WALLET_ADDR, clientKind: 'cli' },
        connections: { wallet: null, github: null },
      }));
      return;
    }
    if (req.url === '/api/auth/logout' && req.method === 'POST') {
      logoutCalls += 1;
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'internal error' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'finchip-logout-failure-'));
  const credentialsPath = join(dir, 'credentials.json');
  const env = {
    FINCHIP_API_URL: origin,
    FINCHIP_CREDENTIALS_PATH: credentialsPath,
  };

  try {
    saveOriginCredentials(origin, {
      finchip_account_session: { value: 'account-secret', expiresAt: null },
    }, { path: credentialsPath });

    const logout = await runCli(['logout', '--json'], env);
    assert.equal(logout.code, 0, `${logout.stderr}\n${logout.stdout}`);
    const result = JSON.parse(logout.stdout);
    assert.equal(result.code, 'LOGGED_OUT');
    assert.equal(result.remoteRevoked, false);
    assert.equal(logoutCalls, 1);

    // Local credentials must be gone even though the server returned 500.
    assert.deepEqual(loadOriginCredentials(origin, { path: credentialsPath }), {});

    const status = await runCli(['status', '--json'], env);
    assert.equal(status.code, 2);
    assert.equal(JSON.parse(status.stdout).code, 'SESSION_REAUTH_REQUIRED');
  } finally {
    await close(server);
  }
});
