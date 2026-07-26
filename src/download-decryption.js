import { createHash } from 'node:crypto';
import { CliError } from './utils.js';
import { unwrapFinchipV2ContentKey } from './download-utils.js';

const MARKER_TO_MODE = Object.freeze({
  FINCHIP_V2: 'finchip',
  LIT_V1: 'lit',
  FINCHIP_V2_ORACLE: 'oracle-v2',
});

export class DownloadError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'DownloadError';
  }
}

export function resolveEncryptionMode(marker) {
  const mode = MARKER_TO_MODE[marker];
  if (!mode) throw new DownloadError('DECRYPT_SCHEME_MISMATCH', `Unsupported on-chain encryption marker: ${marker || '(empty)'}`, 3);
  return mode;
}

export function buildOracleV2SealChallenge({ chipAddress, walletAddress, chainId, jwkFingerprint, nonceMs }) {
  return [
    'FinChip Oracle V2 Seal',
    `Chip: ${chipAddress.toLowerCase()}`,
    `Wallet: ${walletAddress.toLowerCase()}`,
    `ChainId: ${chainId}`,
    `DevicePubkey: ${jwkFingerprint}`,
    `Nonce: ${nonceMs}`,
  ].join('\n');
}

export async function generateOracleClientKeyPair() {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  );
  return {
    publicKeyJwk: await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: pair.privateKey,
  };
}

export async function fingerprintClientPublicJwk(jwk) {
  if (!jwk?.x || !jwk?.y) throw new Error('Oracle client public key is invalid.');
  return createHash('sha256').update(`${jwk.x}.${jwk.y}`).digest('hex');
}

function base64Bytes(value) {
  return Buffer.from(String(value), 'base64');
}

export async function openOracleSealedKey(sealed, clientPrivateKey) {
  const peerPublic = await globalThis.crypto.subtle.importKey(
    'jwk',
    sealed.ephemeralPublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const wrapKey = await globalThis.crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublic },
    clientPrivateKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['unwrapKey'],
  );
  return globalThis.crypto.subtle.unwrapKey(
    'raw',
    base64Bytes(sealed.wrapped),
    wrapKey,
    'AES-KW',
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
}

export function mapOracleSealError(status, payload = {}) {
  const code = payload.code;
  if (code === 'SEAL_EXPIRED') {
    return new DownloadError('DECRYPT_CHALLENGE_EXPIRED', 'Oracle decrypt challenge expired. Run the command again to create a fresh signature.', 5, { resumable: true });
  }
  if (code === 'SEAL_REPLAY') {
    return new DownloadError(
      'DECRYPT_REPLAY_DETECTED',
      'Oracle rejected a reused signature. Stop: the request may have been submitted earlier or raced by another client.',
      5,
      { securitySignal: true, resumable: false },
    );
  }
  if (code === 'SEAL_WRONG_SCHEME') return new DownloadError('DECRYPT_SCHEME_MISMATCH', payload.error || 'The Chip is not sealed with Oracle V2.', 3);
  if (code === 'SEAL_NO_ENVELOPE') return new DownloadError('DECRYPT_ENVELOPE_MISSING', payload.error || 'The Chip has no on-chain encryption envelope.', 3);
  if (code === 'SEAL_NOT_HOLDER') return new DownloadError('LICENSE_REQUIRED', payload.error || 'A creator or license token is required.', 3);
  if (code === 'SEAL_SERVICE_UNAVAILABLE' || status === 502 || status === 503) {
    return new DownloadError('DECRYPT_SERVICE_UNAVAILABLE', payload.error || 'Oracle decrypt service is unavailable.', 5);
  }
  return new DownloadError('DECRYPT_FAILED', payload.error || `Oracle decrypt failed (${status}).`, status >= 500 ? 5 : 3);
}

export async function requestOracleV2Key({
  account,
  chipAddress,
  chainId,
  request,
  now = Date.now,
  generateKeyPair = generateOracleClientKeyPair,
  fingerprint = fingerprintClientPublicJwk,
  openSealed = openOracleSealedKey,
}) {
  let previousNonce = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const keyPair = await generateKeyPair();
    const jwkFingerprint = await fingerprint(keyPair.publicKeyJwk);
    const candidateNonce = now();
    const nonceMs = previousNonce == null ? candidateNonce : Math.max(candidateNonce, previousNonce + 1);
    previousNonce = nonceMs;
    const message = buildOracleV2SealChallenge({
      chipAddress,
      walletAddress: account.address,
      chainId,
      jwkFingerprint,
      nonceMs,
    });
    let signature;
    try {
      signature = await account.signMessage({ message });
    } catch {
      throw new DownloadError('DECRYPT_FAILED', 'Wallet could not sign the Oracle decrypt challenge.', 3);
    }
    let response;
    try {
      response = await request({
        chipAddress,
        chainId,
        walletAddress: account.address.toLowerCase(),
        signature,
        message,
        clientPublicJwk: keyPair.publicKeyJwk,
      });
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError(
        'DECRYPT_SERVICE_UNAVAILABLE',
        'Oracle response was not confirmed. Run the command again to create a fresh keypair, nonce, and signature.',
        5,
        { resumable: true },
      );
    }
    if (
      !response.ok
      || !response.payload?.wrapped
      || !response.payload?.ephemeralPublicJwk
    ) {
      if (response.payload?.code === 'SEAL_EXPIRED' && attempt === 0) continue;
      throw mapOracleSealError(response.status, response.payload);
    }
    try {
      return {
        key: await openSealed({
          wrapped: response.payload.wrapped,
          ephemeralPublicJwk: response.payload.ephemeralPublicJwk,
        }, keyPair.privateKey),
        provenanceId: response.payload.provenanceId || null,
      };
    } catch {
      throw new DownloadError('DECRYPT_FAILED', 'Oracle returned an invalid sealed content key.', 5);
    }
  }
  throw new DownloadError('DECRYPT_CHALLENGE_EXPIRED', 'Oracle decrypt challenge expired.', 5, { resumable: true });
}

function mapV1DecryptError(mode, status, payload = {}) {
  if (payload.code === 'DECRYPT_NOT_HOLDER' || status === 403) {
    return new DownloadError('LICENSE_REQUIRED', payload.error || 'A creator or license token is required.', 3);
  }
  if (mode === 'lit' && status === 502) {
    return new DownloadError('DECRYPT_UPSTREAM_FAILED', payload.error || 'Lit/Chipotle decrypt failed upstream.', 5);
  }
  if (status === 503 || payload.code === 'DECRYPT_SERVICE_UNAVAILABLE') {
    return new DownloadError('DECRYPT_SERVICE_UNAVAILABLE', payload.error || 'Decrypt service is unavailable.', 5);
  }
  return new DownloadError('DECRYPT_FAILED', payload.error || `Decrypt key request failed (${status}).`, status >= 500 ? 5 : 3);
}

async function postJson(client, path, body) {
  try {
    const { response, payload } = await client.json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
    return { ok: response.ok, status: response.status, payload };
  } catch {
    throw new DownloadError('DECRYPT_SERVICE_UNAVAILABLE', 'Unable to confirm the decrypt service response. Run the command again.', 5);
  }
}

export async function requestPackageKey({
  mode,
  ciphertext,
  client,
  account,
  chipAddress,
  chainId,
  now = Date.now,
}) {
  if (mode === 'oracle-v2') {
    const oracle = await requestOracleV2Key({
      account,
      chipAddress,
      chainId,
      now,
      request: body => postJson(client, '/api/oracle-v2/seal', body),
    });
    return { key: oracle.key, provenanceId: oracle.provenanceId };
  }

  const walletAddress = account.address.toLowerCase();
  const message = `FinChip decrypt request\nchip: ${chipAddress}\nwallet: ${walletAddress}\nnonce: ${now()}`;
  let signature;
  try {
    signature = await account.signMessage({ message });
  } catch {
    throw new DownloadError('DECRYPT_FAILED', 'Wallet could not sign the decrypt request.', 3);
  }
  const body = { chipAddress, chainId, walletAddress, signature, message };
  if (mode === 'lit') {
    const result = await postJson(client, '/api/lit-decrypt', { ...body, ciphertext });
    if (!result.ok || typeof result.payload?.aesKeyBase64 !== 'string') {
      throw mapV1DecryptError(mode, result.status, result.payload);
    }
    const key = Buffer.from(result.payload.aesKeyBase64, 'base64');
    if (key.length !== 32) throw new DownloadError('DECRYPT_FAILED', 'Lit returned an invalid content key.', 5);
    return { key, provenanceId: null };
  }

  const result = await postJson(client, '/api/get-key', body);
  if (!result.ok || typeof result.payload?.serverKey !== 'string') {
    throw mapV1DecryptError(mode, result.status, result.payload);
  }
  return {
    key: await unwrapFinchipV2ContentKey(ciphertext, result.payload.serverKey),
    provenanceId: null,
  };
}
