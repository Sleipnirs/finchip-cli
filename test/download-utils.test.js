import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { unzipSync, zipSync, strToU8 } from 'fflate';

import {
  decryptAesGcmPackage,
  integrityLevelForSource,
  parseAndVerifyContentManifest,
  sha256Hex,
  unwrapFinchipV2ContentKey,
  withOracleV2Provenance,
} from '../src/download-utils.js';
import { encryptArtifact, wrapFinchipV2ContentKey } from '../src/publish-utils.js';

test('all four Site source kinds have explicit integrity levels', () => {
  assert.equal(integrityLevelForSource('ipfs_manifest_v1'), 'manifest-and-artifact-hashes');
  assert.equal(integrityLevelForSource('ipfs_encrypted'), 'aead-only');
  assert.equal(integrityLevelForSource('ipfs_plain'), 'transport-only');
  assert.equal(integrityLevelForSource('github'), 'transport-only');
  assert.throws(() => integrityLevelForSource('unknown'), /Unsupported source kind/);
});

test('FINCHIP_V2 unwrap and package decrypt reproduce the original bytes', async () => {
  const contentKey = randomBytes(32);
  const serverKey = `0x${randomBytes(32).toString('hex')}`;
  const plaintext = Buffer.from('download me');
  const encrypted = await encryptArtifact(plaintext, contentKey);
  const envelope = wrapFinchipV2ContentKey(serverKey, contentKey);

  const unwrapped = await unwrapFinchipV2ContentKey(envelope, serverKey);
  const decrypted = await decryptAesGcmPackage(encrypted, unwrapped);
  assert.deepEqual(Buffer.from(decrypted), plaintext);
  unwrapped.fill(0);
});

test('legacy encrypted packages fail closed when the AES-GCM tag is invalid', async () => {
  const contentKey = randomBytes(32);
  const encrypted = await encryptArtifact(Buffer.from('authenticated'), contentKey);
  encrypted[encrypted.length - 1] ^= 0xff;
  await assert.rejects(() => decryptAesGcmPackage(encrypted, contentKey), /authentication/i);
});

test('content manifest must match the on-chain hash and expose the selected bundle artifact', () => {
  const manifest = {
    version: 1,
    hashScheme: 'finchip-ipfs-content-manifest-v1',
    primary: {
      uri: 'ipfs://primary',
      cid: 'primary',
      filename: 'SKILL.md',
      sizeBytes: 10,
      plaintextSha256: `0x${'11'.repeat(32)}`,
      encryptedSha256: `0x${'22'.repeat(32)}`,
    },
    bundleZip: {
      uri: 'ipfs://bundle',
      cid: 'bundle',
      filename: 'source.zip',
      sizeBytes: 20,
      plaintextSha256: `0x${'33'.repeat(32)}`,
      encryptedSha256: `0x${'44'.repeat(32)}`,
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const verified = parseAndVerifyContentManifest(bytes, sha256Hex(bytes));
  assert.equal(verified.artifact.filename, 'source.zip');
  assert.equal(verified.artifactRole, 'bundleZip');
  assert.throws(
    () => parseAndVerifyContentManifest(bytes, `0x${'00'.repeat(32)}`),
    /manifest hash mismatch/i,
  );
});

test('Oracle provenance injection is reported and changes only the output hash', async () => {
  const original = Buffer.from(zipSync({ 'SKILL.md': strToU8('# demo') }));
  const verifiedHash = sha256Hex(original);
  const decorated = await withOracleV2Provenance(original, {
    grantId: 'grant-1',
    walletAddress: '0x1111111111111111111111111111111111111111',
    chipAddress: '0x2222222222222222222222222222222222222222',
    chainId: 56,
  });
  assert.equal(decorated.injected, true);
  assert.notEqual(sha256Hex(decorated.bytes), verifiedHash);
  assert.ok(unzipSync(decorated.bytes)['.finchip-provenance.json']);
});

test('Oracle provenance skips EPUB and signed JAR structures without changing bytes', async () => {
  const epub = Buffer.from(zipSync({ mimetype: strToU8('application/epub+zip'), 'book.txt': strToU8('x') }));
  const signedJar = Buffer.from(zipSync({ 'META-INF/APP.RSA': strToU8('sig'), 'App.class': strToU8('x') }));
  const input = {
    grantId: 'grant-1',
    walletAddress: '0x1111111111111111111111111111111111111111',
    chipAddress: '0x2222222222222222222222222222222222222222',
    chainId: 56,
  };

  const epubResult = await withOracleV2Provenance(epub, input);
  const jarResult = await withOracleV2Provenance(signedJar, input);
  assert.equal(epubResult.injected, false);
  assert.deepEqual(epubResult.bytes, epub);
  assert.equal(jarResult.injected, false);
  assert.deepEqual(jarResult.bytes, signedJar);
});
