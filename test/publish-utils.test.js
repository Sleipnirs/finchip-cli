import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildContentManifest,
  buildSourceBundle,
  canonicalSlug,
  clearPublishState,
  collectPublishSource,
  encryptArtifact,
  isSensitiveSourcePath,
  loadPublishState,
  openRecoverySecret,
  savePublishState,
  sealRecoverySecret,
  selectPrimaryIndex,
  sha256Hex,
  wrapFinchipV2ContentKey,
} from '../src/publish-utils.js';

const PRIVATE_KEY = `0x${'1'.padStart(64, '0')}`;

test('canonical slug preserves one _finchip suffix', () => {
  assert.equal(canonicalSlug('My Skill'), 'my-skill_finchip');
  assert.equal(canonicalSlug('my-skill_finchip'), 'my-skill_finchip');
});

test('source safety rejects common credentials and selects SKILL.md first', () => {
  assert.equal(isSensitiveSourcePath('.env.local'), true);
  assert.equal(isSensitiveSourcePath('keys/wallet-private-key.txt'), true);
  assert.equal(isSensitiveSourcePath('src/wallet.ts'), false);
  assert.equal(isSensitiveSourcePath('src/index.ts'), false);
  assert.equal(selectPrimaryIndex(['src/index.ts', 'docs/SKILL.md']), 1);
});

test('Git source collection follows ignore rules and hard exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-publish-git-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(root, 'SKILL.md'), '# test');
  writeFileSync(join(root, 'index.js'), 'export default 1');
  writeFileSync(join(root, 'ignored.txt'), 'ignored');
  writeFileSync(join(root, '.env'), 'SECRET=value');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'bad.js'), 'bad');

  const source = collectPublishSource(root);
  assert.deepEqual(source.files.map(file => file.relative).sort(), ['.gitignore', 'SKILL.md', 'index.js']);
  assert.equal(source.files[source.primaryIndex].relative, 'SKILL.md');
  assert.ok(buildSourceBundle(source).length > 0);
});

test('artifact encryption uses the site-compatible IV plus AES-GCM ciphertext format', async () => {
  const key = new Uint8Array(32).fill(7);
  const plaintext = Buffer.from('secret source');
  const encrypted = await encryptArtifact(plaintext, key);
  assert.equal(encrypted.length, 12 + plaintext.length + 16);
  assert.notEqual(encrypted.subarray(12).toString('hex'), plaintext.toString('hex'));
});

test('manifest serialization is stable and hashes encrypted artifacts', () => {
  const artifact = {
    uri: 'ipfs://cid', cid: 'cid', filename: 'SKILL.md', sizeBytes: 10,
    plaintextSha256: sha256Hex('plain'), encryptedSha256: sha256Hex('encrypted'),
  };
  const first = buildContentManifest(artifact);
  const second = buildContentManifest({ ...artifact });
  assert.equal(first.bytes.toString(), second.bytes.toString());
  assert.equal(first.contentHash, second.contentHash);
});

test('publish recovery secret is encrypted and requires the same wallet key', () => {
  const secret = Buffer.alloc(32, 9);
  const sealed = sealRecoverySecret(secret, PRIVATE_KEY, 'origin:slug:wallet');
  assert.equal(JSON.stringify(sealed).includes(secret.toString('base64')), false);
  assert.deepEqual(openRecoverySecret(sealed, PRIVATE_KEY, 'origin:slug:wallet'), secret);
  assert.throws(() => openRecoverySecret(sealed, `0x${'2'.padStart(64, '0')}`, 'origin:slug:wallet'));
});

test('publish state is origin scoped, owner-only, and removable', () => {
  const root = mkdtempSync(join(tmpdir(), 'finchip-publish-state-'));
  const path = join(root, 'nested', 'state.json');
  savePublishState('https://finchip.ai', 'a_finchip', { stage: 'broadcast' }, { path });
  assert.equal(loadPublishState('https://finchip.ai', 'a_finchip', { path }).stage, 'broadcast');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /privateKey/);
  clearPublishState('https://finchip.ai', 'a_finchip', { path });
  assert.equal(loadPublishState('https://finchip.ai', 'a_finchip', { path }), null);
});

test('FINCHIP_V2 content-key wrapper produces an opaque base64 envelope', () => {
  const bufferKey = Buffer.alloc(32, 3);
  const typedArrayKey = new Uint8Array(bufferKey);
  const serverKey = Buffer.from('a1'.repeat(32), 'hex');
  const wrappedBuffer = wrapFinchipV2ContentKey(`0x${serverKey.toString('hex')}`, bufferKey);
  const wrappedTypedArray = wrapFinchipV2ContentKey(`0x${serverKey.toString('hex')}`, typedArrayKey);
  assert.ok(Buffer.from(wrappedBuffer, 'base64').length > 40);
  assert.ok(Buffer.from(wrappedTypedArray, 'base64').length > 40);
  assert.equal(wrappedBuffer.includes(bufferKey.toString('base64')), false);
  assert.equal(wrappedTypedArray.includes(bufferKey.toString('base64')), false);
  for (const wrapped of [wrappedBuffer, wrappedTypedArray]) {
    const envelope = Buffer.from(wrapped, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', serverKey, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(envelope.subarray(12, -16)), decipher.final()]);
    assert.equal(plaintext.toString('utf8'), bufferKey.toString('base64'));
  }
});
