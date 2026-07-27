import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FinchipAuthClient, FinchipAuthError, loadOriginCredentials, parseSetCookie } from '../src/auth-client.js';

function response(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

test('Set-Cookie parsing supports expiry and deletion', () => {
  const created = parseSetCookie('finchip_account_session=value; Max-Age=60; HttpOnly', 1_000);
  assert.deepEqual(created, {
    name: 'finchip_account_session',
    value: 'value',
    expiresAt: 61_000,
    remove: false,
  });
  assert.equal(parseSetCookie('finchip_account_session=; Max-Age=0', 1_000).remove, true);
  assert.equal(parseSetCookie('other=value; Max-Age=60', 1_000), null);
});

test('auth client retains challenge in memory and persists only session cookies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-auth-client-'));
  const path = join(dir, 'credentials.json');
  const fetchImpl = async () => response({ ok: true }, {
    headers: {
      'Set-Cookie': 'finchip_wallet_challenge=challenge; Max-Age=60; HttpOnly, finchip_account_session=account; Max-Age=3600; HttpOnly, finchip_wallet_session=wallet; Max-Age=3600; HttpOnly',
    },
  });
  const client = new FinchipAuthClient({ origin: 'https://finchip.ai', fetchImpl, credentialsPath: path });
  await client.request('/api/auth/wallet/login');

  assert.match(client.cookieHeader(), /finchip_wallet_challenge=challenge/);
  const persisted = loadOriginCredentials(client.origin, { path });
  assert.equal(persisted.finchip_account_session.value, 'account');
  assert.equal(persisted.finchip_wallet_session.value, 'wallet');
  assert.equal(persisted.finchip_wallet_challenge, undefined);
});

test('POST requests send Origin and matching-origin cookies only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-origin-'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return response({ ok: true });
  };
  const client = new FinchipAuthClient({ origin: 'https://finchip.ai', fetchImpl, credentialsPath: join(dir, 'credentials.json') });
  client.jar.set('finchip_account_session', { value: 'account', expiresAt: null });
  await client.request('/api/auth/logout', { method: 'POST' });

  assert.equal(calls[0].init.headers.get('Origin'), 'https://finchip.ai');
  assert.equal(calls[0].init.headers.get('Cookie'), 'finchip_account_session=account');
  assert.equal(calls[0].init.redirect, 'manual');
  await assert.rejects(
    () => client.request('https://evil.example/api'),
    error => error instanceof FinchipAuthError && error.code === 'AUTH_NETWORK_ERROR'
  );
});

test('authenticatedFetch clears credentials only after server confirms no session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-401-'));
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1 ? response({ error: 'unauthorized' }, { status: 401 }) : response({ authenticated: false });
  };
  const path = join(dir, 'credentials.json');
  const client = new FinchipAuthClient({ origin: 'https://finchip.ai', fetchImpl, credentialsPath: path });
  client.jar.set('finchip_account_session', { value: 'account', expiresAt: null });
  client.persistCredentials();
  const original = await client.authenticatedFetch('/api/private');

  assert.equal(original.status, 401);
  assert.equal(client.hasPersistedCredentials(), false);
  assert.deepEqual(loadOriginCredentials(client.origin, { path }), {});
});
