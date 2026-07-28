import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  siteCanonicalSlug,
  siteLookupSlug,
  wrapFinchipV2ContentKey,
} from '../src/publish-utils.js';
import { assertOwnerOnlyPermissions } from '../test-support/private-permissions.js';

const PRIVATE_KEY = `0x${'1'.padStart(64, '0')}`;

test('slug helpers separate the Site slug from the legacy on-chain slug', () => {
  assert.equal(canonicalSlug('My Skill'), 'my-skill_finchip');
  assert.equal(canonicalSlug('my-skill_finchip'), 'my-skill_finchip');
  assert.equal(canonicalSlug('my-skill-finchip'), 'my-skill_finchip');
  assert.equal(siteCanonicalSlug('My Skill'), 'my-skill-finchip');
  assert.equal(siteCanonicalSlug('my-skill_finchip'), 'my-skill-finchip');
  assert.equal(siteCanonicalSlug('my-skill-finchip'), 'my-skill-finchip');
  assert.equal(canonicalSlug('my - skill'), 'my-skill_finchip');
  assert.equal(siteCanonicalSlug('my - skill'), 'my-skill-finchip');
  assert.equal(canonicalSlug('AI - Agent Tools'), 'ai-agent-tools_finchip');
  assert.equal(siteCanonicalSlug('AI - Agent Tools'), 'ai-agent-tools-finchip');
});

test('Site lookup slugs normalize FinChip suffixes without rewriting Web2 slugs', () => {
  assert.equal(siteLookupSlug('my---skill_finchip'), 'my-skill-finchip');
  assert.equal(siteLookupSlug('My---Skill-FinChip'), 'my-skill-finchip');
  assert.equal(siteLookupSlug('  bioservices-multi-db-client  '), 'bioservices-multi-db-client');
  assert.equal(siteLookupSlug('Musk-Skill'), 'Musk-Skill');
});

test('source safety rejects common credentials and selects SKILL.md first', () => {
  const sensitive = [
    '.env.local',
    '.npmrc',
    '.yarnrc.yml',
    '.pypirc',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.aws/credentials',
    '.docker/config.json',
    '.kube/config',
    '.config/gh/hosts.yml',
    '.config/gcloud/application_default_credentials.json',
    'infra/prod.tfvars',
    'infra/terraform.tfstate',
    'keys/wallet-private-key.txt',
    'keys/service-account.json',
  ];
  for (const path of sensitive) {
    assert.equal(isSensitiveSourcePath(path), true, `${path} must be excluded`);
  }
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
  writeFileSync(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret');
  writeFileSync(join(root, '.pypirc'), '[pypi]\npassword=secret');
  writeFileSync(join(root, '.netrc'), 'password secret');
  writeFileSync(join(root, 'terraform.tfstate'), '{"secret":"value"}');
  writeFileSync(join(root, 'prod.tfvars'), 'token="secret"');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'bad.js'), 'bad');
  mkdirSync(join(root, '.aws'));
  writeFileSync(join(root, '.aws', 'credentials'), 'aws_secret_access_key=secret');
  mkdirSync(join(root, '.docker'));
  writeFileSync(join(root, '.docker', 'config.json'), '{"auths":{"registry":{"auth":"secret"}}}');
  mkdirSync(join(root, '.kube'));
  writeFileSync(join(root, '.kube', 'config'), 'token: secret');

  const source = collectPublishSource(root);
  assert.deepEqual(source.files.map(file => file.relative).sort(), ['.gitignore', 'SKILL.md', 'index.js']);
  for (const excluded of [
    '.env',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.aws/credentials',
    '.docker/config.json',
    '.kube/config',
    'node_modules/bad.js',
    'prod.tfvars',
    'terraform.tfstate',
  ]) {
    assert.ok(source.excludedSensitivePaths.includes(excluded), `${excluded} must be reported as excluded`);
  }
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
  assertOwnerOnlyPermissions(path, 0o600);
  assertOwnerOnlyPermissions(join(root, 'nested'), 0o700);
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
