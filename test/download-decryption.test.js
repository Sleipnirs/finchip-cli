import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DownloadError,
  generateOracleClientKeyPair,
  openOracleSealedKey,
  requestPackageKey,
  requestOracleV2Key,
  resolveEncryptionMode,
} from '../src/download-decryption.js';
import { wrapFinchipV2ContentKey } from '../src/publish-utils.js';

const CHIP = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

test('on-chain markers resolve to the three public encryption modes', () => {
  assert.equal(resolveEncryptionMode('FINCHIP_V2'), 'finchip');
  assert.equal(resolveEncryptionMode('LIT_V1'), 'lit');
  assert.equal(resolveEncryptionMode('FINCHIP_V2_ORACLE'), 'oracle-v2');
  assert.throws(() => resolveEncryptionMode('UNKNOWN'), /Unsupported on-chain encryption marker/);
});

test('Oracle expired challenge retries once with a fresh keypair, nonce, message, and signature', async () => {
  const attempts = [];
  let keyId = 0;
  const result = await requestOracleV2Key({
    account: {
      address: WALLET,
      async signMessage({ message }) {
        return `signature-${message.split('Nonce: ')[1]}`;
      },
    },
    chipAddress: CHIP,
    chainId: 56,
    now: (() => {
      let value = 1000;
      return () => value++;
    })(),
    async generateKeyPair() {
      keyId += 1;
      return { publicKeyJwk: { x: `x-${keyId}`, y: `y-${keyId}` }, privateKey: `private-${keyId}` };
    },
    async fingerprint(jwk) {
      return `${jwk.x}`.padEnd(64, '0');
    },
    async request(body) {
      attempts.push(body);
      if (attempts.length === 1) {
        return { status: 401, ok: false, payload: { code: 'SEAL_EXPIRED', error: 'expired' } };
      }
      return {
        status: 200,
        ok: true,
        payload: { wrapped: 'wrapped', ephemeralPublicJwk: { x: 'server-x', y: 'server-y' }, provenanceId: 'grant-1' },
      };
    },
    async openSealed(sealed, privateKey) {
      return { sealed, privateKey };
    },
  });

  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].message, attempts[1].message);
  assert.notEqual(attempts[0].signature, attempts[1].signature);
  assert.notDeepEqual(attempts[0].clientPublicJwk, attempts[1].clientPublicJwk);
  assert.equal(result.provenanceId, 'grant-1');
  assert.equal(result.key.privateKey, 'private-2');
});

test('Oracle replay is a hard security stop and is never retried', async () => {
  let requests = 0;
  await assert.rejects(
    () => requestOracleV2Key({
      account: { address: WALLET, signMessage: async () => 'signature' },
      chipAddress: CHIP,
      chainId: 56,
      now: () => 1000,
      generateKeyPair: async () => ({ publicKeyJwk: { x: 'x', y: 'y' }, privateKey: 'private' }),
      fingerprint: async () => '0'.repeat(64),
      async request() {
        requests += 1;
        return { status: 409, ok: false, payload: { code: 'SEAL_REPLAY', error: 'used' } };
      },
      openSealed: async () => null,
    }),
    error => error instanceof DownloadError
      && error.code === 'DECRYPT_REPLAY_DETECTED'
      && error.details.securitySignal === true,
  );
  assert.equal(requests, 1);
});

test('an uncertain Oracle response is not resent with the same signed payload', async () => {
  let requests = 0;
  await assert.rejects(
    () => requestOracleV2Key({
      account: { address: WALLET, signMessage: async () => 'signature' },
      chipAddress: CHIP,
      chainId: 56,
      now: () => 1000,
      generateKeyPair: async () => ({ publicKeyJwk: { x: 'x', y: 'y' }, privateKey: 'private' }),
      fingerprint: async () => '0'.repeat(64),
      async request() {
        requests += 1;
        throw new Error('connection reset');
      },
      openSealed: async () => null,
    }),
    error => error.code === 'DECRYPT_SERVICE_UNAVAILABLE'
      && error.details.resumable === true
      && /fresh keypair, nonce, and signature/i.test(error.message),
  );
  assert.equal(requests, 1);
});

test('Oracle preserves a stable DownloadError already produced by the request layer', async () => {
  const lowerLevel = new DownloadError(
    'DECRYPT_SERVICE_UNAVAILABLE',
    'Lower-level request diagnostic.',
    5,
    { source: 'postJson', resumable: true },
  );
  await assert.rejects(
    () => requestOracleV2Key({
      account: { address: WALLET, signMessage: async () => 'signature' },
      chipAddress: CHIP,
      chainId: 56,
      now: () => 1000,
      generateKeyPair: async () => ({ publicKeyJwk: { x: 'x', y: 'y' }, privateKey: 'private' }),
      fingerprint: async () => '0'.repeat(64),
      request: async () => { throw lowerLevel; },
      openSealed: async () => null,
    }),
    error => error === lowerLevel
      && error.message === 'Lower-level request diagnostic.'
      && error.details.source === 'postJson',
  );
});

test('Oracle service codes map without treating every 401 as authorization failure', async () => {
  const cases = [
    [401, 'SEAL_EXPIRED', 'DECRYPT_CHALLENGE_EXPIRED'],
    [409, 'SEAL_WRONG_SCHEME', 'DECRYPT_SCHEME_MISMATCH'],
    [404, 'SEAL_NO_ENVELOPE', 'DECRYPT_ENVELOPE_MISSING'],
    [403, 'SEAL_NOT_HOLDER', 'LICENSE_REQUIRED'],
    [503, 'SEAL_SERVICE_UNAVAILABLE', 'DECRYPT_SERVICE_UNAVAILABLE'],
    [401, 'SEAL_FAILED', 'DECRYPT_FAILED'],
  ];
  for (const [status, siteCode, expected] of cases) {
    let calls = 0;
    await assert.rejects(
      () => requestOracleV2Key({
        account: { address: WALLET, signMessage: async () => 'signature' },
        chipAddress: CHIP,
        chainId: 56,
        now: () => 1000 + calls,
        generateKeyPair: async () => ({ publicKeyJwk: { x: 'x', y: 'y' }, privateKey: 'private' }),
        fingerprint: async () => '0'.repeat(64),
        async request() {
          calls += 1;
          return { status, ok: false, payload: { code: siteCode, error: siteCode } };
        },
        openSealed: async () => null,
      }),
      error => error.code === expected,
    );
    assert.equal(calls, siteCode === 'SEAL_EXPIRED' ? 2 : 1);
  }
});

test('FinChip and Lit key endpoints use their exact payloads and stable errors', async () => {
  const rawKey = Buffer.alloc(32, 7);
  const serverKey = `0x${Buffer.alloc(32, 8).toString('hex')}`;
  const envelope = wrapFinchipV2ContentKey(serverKey, rawKey);
  const requests = [];
  const account = { address: WALLET, signMessage: async ({ message }) => `sig:${message}` };
  const client = {
    async json(path, options) {
      requests.push({ path, body: JSON.parse(options.body) });
      return { response: { ok: true, status: 200 }, payload: { serverKey } };
    },
  };
  const result = await requestPackageKey({
    mode: 'finchip',
    ciphertext: envelope,
    client,
    account,
    chipAddress: CHIP,
    chainId: 56,
    now: () => 1234,
  });
  assert.deepEqual(result.key, rawKey);
  assert.equal(requests[0].path, '/api/get-key');
  assert.equal(requests[0].body.walletAddress, WALLET);
  assert.match(requests[0].body.message, /nonce: 1234$/);

  client.json = async () => ({
    response: { ok: false, status: 502 },
    payload: { code: 'DECRYPT_SERVICE_UNAVAILABLE', error: 'provider down' },
  });
  await assert.rejects(
    () => requestPackageKey({
      mode: 'lit',
      ciphertext: 'lit-ciphertext',
      client,
      account,
      chipAddress: CHIP,
      chainId: 56,
    }),
    error => error.code === 'DECRYPT_UPSTREAM_FAILED',
  );
});

test('Oracle ECDH unwrap returns a non-extractable AES-GCM key', async () => {
  const client = await generateOracleClientKeyPair();
  const clientPublic = await crypto.subtle.importKey(
    'jwk',
    client.publicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const server = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const wrapKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: clientPublic },
    server.privateKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey'],
  );
  const delivered = await crypto.subtle.importKey('raw', Buffer.alloc(32, 9), { name: 'AES-GCM' }, true, ['decrypt']);
  const wrapped = await crypto.subtle.wrapKey('raw', delivered, wrapKey, 'AES-KW');
  const ephemeralPublicJwk = await crypto.subtle.exportKey('jwk', server.publicKey);
  const opened = await openOracleSealedKey({
    wrapped: Buffer.from(wrapped).toString('base64'),
    ephemeralPublicJwk,
  }, client.privateKey);
  assert.equal(opened.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('raw', opened));
});
