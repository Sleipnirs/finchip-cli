import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalConfirmation } from '../src/localhost-confirmation.js';

const FINCHIP_ORIGIN = 'https://finchip.ai';

test('localhost confirmation CSP permits only self and the official browser handoff origin', async () => {
  let openLocalPage;
  const localPageReady = new Promise(resolve => { openLocalPage = resolve; });
  const redirectUrl = `${FINCHIP_ORIGIN}/auth/agent/complete#handoff=test-secret`;
  const confirmation = runLocalConfirmation({
    origin: FINCHIP_ORIGIN,
    walletAddr: '0x0000000000000000000000000000000000000001',
    purpose: 'Test browser handoff',
    timeoutMs: 5_000,
    openBrowser: localUrl => openLocalPage(localUrl),
    onConfirm: async () => ({ redirectUrl }),
  });

  const localUrl = await localPageReady;
  const page = await fetch(localUrl);
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /form-action 'self' https:\/\/finchip\.ai(?:;|\s)/);
  assert.doesNotMatch(csp, /form-action[^;]*\*/);

  const submitted = await fetch(localUrl, { method: 'POST', redirect: 'manual' });
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.get('location'), redirectUrl);
  assert.equal((await confirmation).redirectUrl, redirectUrl);
});
