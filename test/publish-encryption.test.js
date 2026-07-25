import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';

import {
  assertEncryptionModeSupported,
  normalizeEncryptionMode,
  normalizeResumeEncryptionState,
  prepareEncryptionEnvelope,
  resumeNeedsContentKey,
  verifyEncryptionTuple,
} from '../src/publish-encryption.js';

const CHIP = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const SERVER_KEY = `0x${'a1'.repeat(32)}`;
const CONTENT_KEY = Buffer.alloc(32, 7);
const CHAIN = { id: 56, key: 'bsc' };

function fakeContext(mode, responder) {
  const requests = [];
  return {
    requests,
    input: {
      mode,
      contentKey: CONTENT_KEY,
      chain: CHAIN,
      contractAddr: CHIP,
      walletAddr: WALLET,
      signMessage: async () => `0x${'ab'.repeat(65)}`,
      request: async (path, options) => {
        const body = JSON.parse(options.body);
        requests.push({ path, body });
        return responder(path, body);
      },
    },
  };
}

test('encryption modes normalize with finchip as the new-publish default', () => {
  assert.equal(normalizeEncryptionMode(), 'finchip');
  assert.equal(normalizeEncryptionMode('LIT'), 'lit');
  assert.equal(normalizeEncryptionMode('oracle-v2'), 'oracle-v2');
  assert.throws(() => normalizeEncryptionMode('agent'), error => error.code === 'PUBLISH_INVALID');
});

test('FinChip wraps the Base64 CK locally and writes FINCHIP_V2', async () => {
  const context = fakeContext('finchip', async () => ({
    response: { ok: true, status: 200 },
    payload: { serverKey: SERVER_KEY },
  }));
  const envelope = await prepareEncryptionEnvelope(context.input);
  assert.equal(envelope.marker, 'FINCHIP_V2');
  assert.equal(envelope.chainTag, 'bsc');
  assert.equal(envelope.contentKeyFormat, 'raw-32-v1');
  assert.equal(context.requests[0].path, '/api/get-key');
  assert.equal('version' in context.requests[0].body, false);
  assert.equal('aesKeyBase64' in context.requests[0].body, false);

  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(SERVER_KEY.slice(2), 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  assert.equal(plaintext.toString('utf8'), CONTENT_KEY.toString('base64'));
});

test('Lit sends Base64 CK to the Site once and writes LIT_V1', async () => {
  const context = fakeContext('lit', async () => ({
    response: { ok: true, status: 200 },
    payload: { ciphertext: 'lit-envelope' },
  }));
  const envelope = await prepareEncryptionEnvelope(context.input);
  assert.equal(envelope.marker, 'LIT_V1');
  assert.equal(envelope.ciphertext, 'lit-envelope');
  assert.equal(envelope.envelopeScheme, 'lit-v1-chipotle');
  assert.equal(context.requests[0].path, '/api/lit-encrypt');
  assert.equal(context.requests[0].body.aesKeyBase64, CONTENT_KEY.toString('base64'));
});

test('Oracle V2 asks for version v2 and wraps raw 32-byte CK locally', async () => {
  const context = fakeContext('oracle-v2', async () => ({
    response: { ok: true, status: 200 },
    payload: { serverKey: SERVER_KEY, version: 'v2' },
  }));
  const envelope = await prepareEncryptionEnvelope(context.input);
  assert.equal(envelope.marker, 'FINCHIP_V2_ORACLE');
  assert.equal(envelope.envelopeScheme, 'finchip-oracle-v2-raw-ck');
  assert.equal(context.requests[0].path, '/api/get-key');
  assert.equal(context.requests[0].body.version, 'v2');

  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(SERVER_KEY.slice(2), 'hex'), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  assert.deepEqual(plaintext, CONTENT_KEY);
});

test('Lit is rejected on Arbitrum Sepolia before calling the Site', () => {
  assert.throws(
    () => assertEncryptionModeSupported('lit', { id: 421614, key: 'arbsepolia' }),
    error => error.code === 'ENCRYPTION_MODE_UNSUPPORTED_ON_CHAIN',
  );
  assert.doesNotThrow(() => assertEncryptionModeSupported('finchip', { id: 421614, key: 'arbsepolia' }));
  assert.doesNotThrow(() => assertEncryptionModeSupported('oracle-v2', { id: 421614, key: 'arbsepolia' }));
});

test('on-chain verification treats marker/ciphertext as strict and chain tag as warning', () => {
  const expected = { ciphertext: 'sealed', marker: 'LIT_V1', chainTag: 'bsc' };
  assert.deepEqual(
    verifyEncryptionTuple(expected, ['sealed', 'LIT_V1', 'ethereum']),
    { warnings: ['On-chain encryption chain tag is "ethereum"; saved diagnostic tag is "bsc".'] },
  );
  assert.throws(
    () => verifyEncryptionTuple(expected, ['other', 'LIT_V1', 'bsc']),
    error => error.code === 'KEY_SETUP_FAILED',
  );
  assert.throws(
    () => verifyEncryptionTuple(expected, ['sealed', 'FINCHIP_V2', 'bsc']),
    error => error.code === 'KEY_SETUP_FAILED',
  );
});

test('legacy recovery accepts non-empty ciphertext with the correct marker and warns', () => {
  const result = verifyEncryptionTuple(
    { marker: 'FINCHIP_V2', chainTag: 'bsc' },
    ['legacy-envelope', 'FINCHIP_V2', 'bsc'],
  );
  assert.match(result.warnings[0], /legacy/i);
  assert.throws(
    () => verifyEncryptionTuple({ marker: 'FINCHIP_V2' }, ['', 'FINCHIP_V2', 'bsc']),
    error => error.code === 'KEY_SETUP_FAILED',
  );
});

test('legacy resume state becomes finchip while explicit mode and encoding conflicts are rejected', () => {
  const legacy = normalizeResumeEncryptionState(
    { slug: 'legacy_finchip', stage: 'registered' },
    undefined,
    CHAIN,
  );
  assert.equal(legacy.mode, 'finchip');
  assert.equal(legacy.contentKeyFormat, 'raw-32-v1');
  assert.equal(legacy.marker, 'FINCHIP_V2');
  assert.equal(resumeNeedsContentKey(legacy), true);

  assert.throws(
    () => normalizeResumeEncryptionState(
      { slug: 'lit_finchip', stage: 'registered', mode: 'lit' },
      'finchip',
      CHAIN,
    ),
    error => error.code === 'PUBLISH_STATE_MISMATCH',
  );
  assert.throws(
    () => normalizeResumeEncryptionState(
      { slug: 'bad_finchip', stage: 'registered', mode: 'oracle-v2', contentKeyFormat: 'base64-text' },
      undefined,
      CHAIN,
    ),
    error => error.code === 'PUBLISH_STATE_MISMATCH',
  );
  assert.throws(
    () => normalizeResumeEncryptionState(
      { version: 2, slug: 'missing_finchip', stage: 'key_prepared', mode: 'lit' },
      undefined,
      CHAIN,
    ),
    error => error.code === 'PUBLISH_STATE_MISMATCH',
  );
});

test('prepared and submitted recovery reuse the saved envelope without reopening CK', () => {
  assert.equal(resumeNeedsContentKey({ stage: 'key_prepared' }), false);
  assert.equal(resumeNeedsContentKey({ stage: 'key_submitted' }), false);
  assert.equal(resumeNeedsContentKey({ stage: 'registered', setLitTxHash: `0x${'ab'.repeat(32)}` }), false);
});

for (const [status, mode, code] of [
  [503, 'finchip', 'ENCRYPTION_SERVICE_UNAVAILABLE'],
  [503, 'lit', 'ENCRYPTION_SERVICE_UNAVAILABLE'],
  [502, 'lit', 'ENCRYPTION_UPSTREAM_FAILED'],
  [403, 'oracle-v2', 'ENCRYPTION_NOT_AUTHORIZED'],
  [401, 'finchip', 'ENCRYPTION_NOT_AUTHORIZED'],
]) {
  test(`${mode} maps HTTP ${status} to ${code}`, async () => {
    const context = fakeContext(mode, async () => ({
      response: { ok: false, status },
      payload: { error: 'server detail' },
    }));
    await assert.rejects(
      prepareEncryptionEnvelope(context.input),
      error => error.code === code && error.details.encryptionMode === mode,
    );
  });
}
