import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';

import { downloadSkill } from '../src/commands/download.js';
import { DownloadError } from '../src/download-decryption.js';
import { sha256Hex } from '../src/download-utils.js';
import { encryptArtifact } from '../src/publish-utils.js';

const CHIP = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

function fakeClient(session = null) {
  return {
    origin: 'https://finchip.ai',
    hasPersistedCredentials: () => Boolean(session),
    getSession: async () => session,
    clearCredentials() {},
  };
}

function baseDeps(overrides = {}) {
  const writes = [];
  return {
    writes,
    deps: {
      cfg: { rpc: null },
      account: {
        address: WALLET,
        signMessage: async () => '0xsigned',
      },
      client: fakeClient(),
      publicClient: {
        async readContract({ functionName }) {
          if (functionName === 'getLitData') return ['envelope', 'FINCHIP_V2', 'bsc'];
          throw new Error(`unexpected ${functionName}`);
        },
      },
      writeOutput(path, bytes) {
        writes.push({ path, bytes: Buffer.from(bytes) });
      },
      ...overrides,
    },
  };
}

test('github and ipfs_plain downloads save transport-only bytes without decrypting', async () => {
  for (const kind of ['github', 'ipfs_plain']) {
    const { deps, writes } = baseDeps({
      requestSourceManifest: async () => ({
        kind,
        files: [{ name: kind === 'github' ? 'repo.zip' : 'SKILL.md', path: 'source', encrypted: false }],
        packageDownloadUrl: `/source/${kind}`,
      }),
      downloadPackage: async () => ({
        bytes: Buffer.from(kind),
        contentDisposition: null,
        contentType: 'application/octet-stream',
      }),
    });
    const result = await downloadSkill('demo_finchip', {
      chain: '56',
      addr: CHIP,
      dir: 'output',
    }, deps);
    assert.equal(result.sourceKind, kind);
    assert.equal(result.encryptionMode, null);
    assert.equal(result.integrityLevel, 'transport-only');
    assert.equal(result.verifiedPlaintextSha256, null);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].bytes, Buffer.from(kind));
  }
});

test('legacy ipfs_encrypted reports AEAD-only integrity and decrypts with the on-chain mode', async () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('legacy source');
  const encrypted = await encryptArtifact(plaintext, key);
  const { deps, writes } = baseDeps({
    requestSourceManifest: async () => ({
      kind: 'ipfs_encrypted',
      files: [{ name: 'legacy.zip.enc', path: 'ipfs://legacy', encrypted: true }],
      packageDownloadUrl: '/source/legacy',
    }),
    downloadPackage: async () => ({
      bytes: encrypted,
      contentDisposition: 'attachment; filename="legacy.zip.enc"',
      contentType: 'application/octet-stream',
    }),
    requestPackageKey: async () => ({ key: Buffer.from(key), provenanceId: null }),
  });
  const result = await downloadSkill('legacy_finchip', {
    chain: '56',
    addr: CHIP,
    dir: 'output',
  }, deps);
  assert.equal(result.encryptionMode, 'finchip');
  assert.equal(result.integrityLevel, 'aead-only');
  assert.equal(result.verifiedPlaintextSha256, null);
  assert.deepEqual(writes[0].bytes, plaintext);
});

test('package authentication failures return DECRYPT_FAILED and never write output', async () => {
  const key = randomBytes(32);
  const encrypted = await encryptArtifact(Buffer.from('secret'), key);
  encrypted[encrypted.length - 1] ^= 0xff;
  const { deps, writes } = baseDeps({
    requestSourceManifest: async () => ({
      kind: 'ipfs_encrypted',
      files: [{ name: 'legacy.enc', path: 'ipfs://legacy', encrypted: true }],
      packageDownloadUrl: '/source/legacy',
    }),
    downloadPackage: async () => ({ bytes: encrypted, contentDisposition: null, contentType: 'application/octet-stream' }),
    requestPackageKey: async () => ({ key: Buffer.from(key), provenanceId: null }),
  });
  await assert.rejects(
    () => downloadSkill('legacy_finchip', { chain: '56', addr: CHIP }, deps),
    error => error.code === 'DECRYPT_FAILED',
  );
  assert.equal(writes.length, 0);
});

test('manifest v1 verifies the on-chain manifest and both artifact hashes before Oracle provenance', async () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from(zipSync({ 'SKILL.md': strToU8('# verified') }));
  const encrypted = await encryptArtifact(plaintext, key);
  const artifact = {
    uri: 'ipfs://bundle',
    cid: 'bundle',
    filename: 'source.zip',
    sizeBytes: encrypted.length,
    plaintextSha256: sha256Hex(plaintext),
    encryptedSha256: sha256Hex(encrypted),
  };
  const contentManifest = {
    version: 1,
    hashScheme: 'finchip-ipfs-content-manifest-v1',
    primary: artifact,
    bundleZip: null,
  };
  const manifestBytes = Buffer.from(JSON.stringify(contentManifest));
  const contentHash = sha256Hex(manifestBytes);
  const { deps, writes } = baseDeps({
    requestSourceManifest: async () => ({
      kind: 'ipfs_manifest_v1',
      files: [{ name: 'source.zip', path: 'ipfs://bundle', encrypted: true, artifactRole: 'primary' }],
      packageDownloadUrl: '/source/verified',
      manifestUri: 'ipfs://manifest',
      manifestSha256: contentHash,
    }),
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === 'contentHash') return contentHash;
        if (functionName === 'sourceUrl') return 'ipfs://manifest';
        if (functionName === 'getLitData') return ['oracle-envelope', 'FINCHIP_V2_ORACLE', 'bsc'];
        throw new Error(`unexpected ${functionName}`);
      },
    },
    fetchIpfs: async () => manifestBytes,
    downloadPackage: async () => ({ bytes: encrypted, contentDisposition: null, contentType: 'application/octet-stream' }),
    requestPackageKey: async () => ({ key: Buffer.from(key), provenanceId: 'grant-1' }),
  });
  const result = await downloadSkill('verified_finchip', {
    chain: '56',
    addr: CHIP,
    dir: 'output',
  }, deps);
  assert.equal(result.encryptionMode, 'oracle-v2');
  assert.equal(result.integrityLevel, 'manifest-and-artifact-hashes');
  assert.equal(result.verifiedPlaintextSha256, sha256Hex(plaintext));
  assert.equal(result.provenanceInjected, true);
  assert.equal(result.outputDiffersFromVerifiedPlaintext, true);
  assert.notDeepEqual(writes[0].bytes, plaintext);

  writes.length = 0;
  const exact = await downloadSkill('verified_finchip', {
    chain: '56',
    addr: CHIP,
    dir: 'output',
    provenance: false,
  }, deps);
  assert.equal(exact.provenanceInjected, false);
  assert.equal(exact.outputDiffersFromVerifiedPlaintext, false);
  assert.deepEqual(writes[0].bytes, plaintext);
});

test('an expired package token refreshes the manifest once before any decrypt request', async () => {
  let manifests = 0;
  let downloads = 0;
  let decrypts = 0;
  const { deps } = baseDeps({
    requestSourceManifest: async () => {
      manifests += 1;
      return {
        kind: 'ipfs_plain',
        files: [{ name: 'SKILL.md', path: 'ipfs://x', encrypted: false }],
        packageDownloadUrl: `/source?token=${manifests}`,
      };
    },
    downloadPackage: async () => {
      downloads += 1;
      if (downloads === 1) throw new DownloadError('DOWNLOAD_LINK_EXPIRED', 'expired', 5, { refreshManifest: true });
      return { bytes: Buffer.from('ready'), contentDisposition: null, contentType: 'text/plain' };
    },
    requestPackageKey: async () => {
      decrypts += 1;
      throw new Error('not expected');
    },
  });
  await downloadSkill('demo_finchip', { chain: '56', addr: CHIP }, deps);
  assert.equal(manifests, 2);
  assert.equal(downloads, 2);
  assert.equal(decrypts, 0);
});

test('an active cookie wallet mismatch fails before source access', async () => {
  let manifests = 0;
  const { deps } = baseDeps({
    client: fakeClient({
      authenticated: true,
      wallet: { walletAddr: '0x3333333333333333333333333333333333333333' },
    }),
    requestSourceManifest: async () => {
      manifests += 1;
      throw new Error('not expected');
    },
  });
  await assert.rejects(
    () => downloadSkill('demo_finchip', { chain: '56', addr: CHIP }, deps),
    error => error.code === 'WALLET_MISMATCH',
  );
  assert.equal(manifests, 0);
});
