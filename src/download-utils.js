import { createDecipheriv, createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const MANIFEST_HASH_SCHEME = 'finchip-ipfs-content-manifest-v1';
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZIP_MAGIC = new Set(['504b0304', '504b0506']);
const JAR_SIGNATURE_RE = /^META-INF\/.*\.(?:SF|RSA|DSA)$/i;

const INTEGRITY_LEVELS = Object.freeze({
  github: 'transport-only',
  ipfs_plain: 'transport-only',
  ipfs_encrypted: 'aead-only',
  ipfs_manifest_v1: 'manifest-and-artifact-hashes',
});

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function sha256Hex(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

export function integrityLevelForSource(kind) {
  const level = INTEGRITY_LEVELS[kind];
  if (!level) throw new Error(`Unsupported source kind: ${kind}`);
  return level;
}

export function verifySha256(value, expected, label) {
  const actual = sha256Hex(value);
  if (!expected || actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} hash mismatch.`);
  }
  return actual;
}

export async function decryptAesGcmPackage(encrypted, rawKey) {
  const packageBytes = bytes(encrypted);
  if (packageBytes.length < 12 + 16) {
    throw new Error('AES-GCM authentication failed: encrypted package is too short.');
  }
  try {
    const iv = packageBytes.subarray(0, 12);
    const payload = packageBytes.subarray(12);
    if (rawKey && typeof rawKey === 'object' && rawKey.constructor?.name === 'CryptoKey') {
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        rawKey,
        payload,
      );
      return Buffer.from(plain);
    }
    const key = bytes(rawKey);
    if (key.length !== 32) throw new Error('Content key must be exactly 32 bytes.');
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      key,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      payload,
    );
    return Buffer.from(plain);
  } catch (error) {
    if (/exactly 32 bytes/.test(error?.message || '')) throw error;
    throw new Error('AES-GCM authentication failed; the package or content key is invalid.');
  }
}

export async function unwrapFinchipV2ContentKey(envelopeBase64, serverKeyHex) {
  try {
    const key = Buffer.from(String(serverKeyHex).replace(/^0x/, ''), 'hex');
    const envelope = Buffer.from(String(envelopeBase64), 'base64');
    if (key.length !== 32 || envelope.length < 12 + 16) throw new Error('invalid envelope');
    const iv = envelope.subarray(0, 12);
    const ciphertext = envelope.subarray(12, -16);
    const tag = envelope.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const encodedKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const contentKey = Buffer.from(encodedKey, 'base64');
    if (contentKey.length !== 32) throw new Error('invalid content key');
    return contentKey;
  } catch {
    throw new Error('The FINCHIP_V2 content-key envelope is invalid.');
  }
}

function isArtifact(value) {
  return value
    && typeof value === 'object'
    && typeof value.uri === 'string'
    && value.uri.startsWith('ipfs://')
    && typeof value.cid === 'string'
    && typeof value.filename === 'string'
    && Number.isFinite(value.sizeBytes)
    && value.sizeBytes >= 0
    && HEX_32_RE.test(value.plaintextSha256 || '')
    && HEX_32_RE.test(value.encryptedSha256 || '');
}

export function parseAndVerifyContentManifest(manifestBytes, expectedHash) {
  verifySha256(manifestBytes, expectedHash, 'On-chain content manifest');
  let manifest;
  try {
    manifest = JSON.parse(bytes(manifestBytes).toString('utf8'));
  } catch {
    throw new Error('On-chain content manifest is not valid JSON.');
  }
  if (
    manifest?.version !== 1
    || manifest?.hashScheme !== MANIFEST_HASH_SCHEME
    || !isArtifact(manifest.primary)
    || (manifest.bundleZip !== null && !isArtifact(manifest.bundleZip))
  ) {
    throw new Error('On-chain content manifest does not match finchip-ipfs-content-manifest-v1.');
  }
  return {
    manifest,
    artifact: manifest.bundleZip || manifest.primary,
    artifactRole: manifest.bundleZip ? 'bundleZip' : 'primary',
  };
}

function isZip(value) {
  return ZIP_MAGIC.has(bytes(value).subarray(0, 4).toString('hex'));
}

export async function withOracleV2Provenance(decrypted, input) {
  const original = bytes(decrypted);
  if (!isZip(original)) return { bytes: original, injected: false };
  try {
    const entries = unzipSync(original);
    const names = Object.keys(entries);
    if (names[0] === 'mimetype' || names.some(name => JAR_SIGNATURE_RE.test(name))) {
      return { bytes: original, injected: false };
    }
    entries['.finchip-provenance.json'] = strToU8(JSON.stringify({
      grantId: input.grantId,
      wallet: input.walletAddress.toLowerCase(),
      chip: input.chipAddress.toLowerCase(),
      chainId: input.chainId,
      note: 'FinChip licensed-download provenance marker. Not tamper-proof; removing this file does not affect the skill content.',
    }, null, 2));
    return { bytes: Buffer.from(zipSync(entries, { level: 6 })), injected: true };
  } catch {
    return { bytes: original, injected: false };
  }
}

export function safeDownloadName(name, encrypted = false) {
  const cleaned = String(name || '').trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^\.+/, '') || 'source-package';
  return encrypted && cleaned.toLowerCase().endsWith('.enc') ? cleaned.slice(0, -4) : cleaned;
}

export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); }
    catch { return encoded.trim(); }
  }
  return header.match(/filename="([^"]+)"/i)?.[1]?.trim()
    || header.match(/filename=([^;]+)/i)?.[1]?.trim()
    || null;
}

export function downloadNameFromContent(preferredName, content, encrypted = false) {
  const cleaned = safeDownloadName(preferredName, encrypted);
  if (/\.[A-Za-z0-9]{1,12}$/.test(cleaned) && !/\.(?:bin|enc)$/i.test(cleaned)) return cleaned;
  const head = bytes(content).subarray(0, 16).toString('hex');
  let extension = 'bin';
  if (head.startsWith('504b0304') || head.startsWith('504b0506')) extension = 'zip';
  else if (head.startsWith('89504e47')) extension = 'png';
  else if (head.startsWith('ffd8ff')) extension = 'jpg';
  else if (head.startsWith('25504446')) extension = 'pdf';
  else if (head.startsWith('1f8b')) extension = 'gz';
  else {
    const sample = bytes(content).subarray(0, 512).toString('utf8');
    if (/^#{1,6} |\*\*/m.test(sample)) extension = 'md';
    else if (/^\s*[{[]/.test(sample)) extension = 'json';
    else if (/^#!.*python|^import |^from .* import|^def |^class /m.test(sample)) extension = 'py';
    else if (/^import |^export |^const |^let |^function /m.test(sample)) extension = 'js';
    else if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(sample)) extension = 'txt';
  }
  const base = cleaned.replace(/\.[A-Za-z0-9]{1,12}$/, '');
  return `${base}.${extension}`;
}
