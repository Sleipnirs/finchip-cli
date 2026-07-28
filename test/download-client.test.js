import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DownloadError,
  requestSourceManifest,
  downloadPackage,
  validateSourceManifest,
} from '../src/download-client.js';

const CHIP = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

test('source manifest is cookie-first and falls back to the canonical signed viewer body', async () => {
  const calls = [];
  const client = {
    origin: 'https://finchip.ai',
    async json(path, options) {
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      if (calls.length === 1) return { response: { ok: false, status: 401 }, payload: { error: 'sign' } };
      return {
        response: { ok: true, status: 200 },
        payload: {
          kind: 'ipfs_plain',
          files: [{ name: 'SKILL.md', path: 'ipfs://x', encrypted: false }],
          packageDownloadUrl: '/api/v2/skills/demo/source?token=secret',
        },
      };
    },
  };
  const account = {
    address: WALLET,
    async signMessage({ message }) {
      assert.match(message, /^FinChip V2\nAction: skill_detail_viewer/m);
      assert.match(message, /Slug: demo-finchip/);
      assert.match(message, /Wallet: 0x2222/);
      return '0xsigned';
    },
  };

  const manifest = await requestSourceManifest({
    client,
    slug: 'demo_finchip',
    deployment: { addr: CHIP, chainId: 56 },
    account,
    now: () => 1234,
  });

  assert.equal(manifest.kind, 'ipfs_plain');
  assert.equal(calls[0].path, '/api/v2/skills/demo-finchip/source/manifest');
  assert.deepEqual(calls[0].body, { addr: CHIP, chainId: 56 });
  assert.equal(calls[1].body.wallet_addr, WALLET);
  assert.equal(calls[1].body.signature, '0xsigned');
  assert.equal(calls[1].body.timestamp, 1234);
  assert.equal(calls[1].body.signature_chain_id, 56);
  assert.match(calls[1].body.content_hash, /^[0-9a-f]{64}$/);
});

test('source manifest normalizes a legacy FinChip slug in both URL and viewer signature', async () => {
  const calls = [];
  const client = {
    origin: 'https://finchip.ai',
    async json(path, options) {
      calls.push({ path, body: JSON.parse(options.body) });
      if (calls.length === 1) {
        return { response: { ok: false, status: 401 }, payload: { error: 'sign' } };
      }
      return {
        response: { ok: true, status: 200 },
        payload: {
          kind: 'ipfs_plain',
          files: [{ name: 'SKILL.md', path: 'ipfs://x', encrypted: false }],
          packageDownloadUrl: '/api/v2/skills/demo/source?token=secret',
        },
      };
    },
  };
  const account = {
    address: WALLET,
    async signMessage({ message }) {
      assert.match(message, /Slug: demo-finchip/);
      return '0xsigned';
    },
  };

  await requestSourceManifest({
    client,
    slug: 'demo_finchip',
    deployment: { addr: CHIP, chainId: 56 },
    account,
    now: () => 1234,
  });

  assert.equal(calls[0].path, '/api/v2/skills/demo-finchip/source/manifest');
  assert.equal(calls[1].path, '/api/v2/skills/demo-finchip/source/manifest');
});

test('signed source fallback requires a wallet while license failures preserve stable codes', async () => {
  const client = {
    origin: 'https://finchip.ai',
    async json() {
      return { response: { ok: false, status: 401 }, payload: { error: 'Authentication required' } };
    },
  };
  await assert.rejects(
    () => requestSourceManifest({
      client,
      slug: 'demo_finchip',
      deployment: { addr: CHIP, chainId: 56 },
      account: null,
    }),
    error => error.code === 'AUTH_REQUIRED',
  );

  client.json = async () => ({
    response: { ok: false, status: 403 },
    payload: { code: 'LICENSE_REQUIRED', error: 'License required.' },
  });
  await assert.rejects(
    () => requestSourceManifest({
      client,
      slug: 'demo_finchip',
      deployment: { addr: CHIP, chainId: 56 },
      account: null,
    }),
    error => error.code === 'LICENSE_REQUIRED',
  );
});

test('package download rejects cross-origin URLs before sending any cookie or token', async () => {
  let calls = 0;
  const client = {
    origin: 'https://finchip.ai',
    async request() {
      calls += 1;
      throw new Error('must not run');
    },
  };
  await assert.rejects(
    () => downloadPackage(client, 'https://evil.example/steal?token=secret'),
    error => error instanceof DownloadError && error.code === 'SOURCE_ORIGIN_MISMATCH',
  );
  assert.equal(calls, 0);
});

test('all four manifest variants are accepted and malformed variants are rejected', () => {
  const common = {
    files: [{ name: 'source.enc', path: 'ipfs://x', encrypted: true }],
    packageDownloadUrl: '/api/source?token=x',
  };
  for (const kind of ['github', 'ipfs_plain', 'ipfs_encrypted']) {
    assert.equal(validateSourceManifest({ kind, ...common }).kind, kind);
  }
  assert.equal(validateSourceManifest({
    kind: 'ipfs_manifest_v1',
    ...common,
    manifestUri: 'ipfs://manifest',
    manifestSha256: `0x${'11'.repeat(32)}`,
  }).kind, 'ipfs_manifest_v1');
  assert.throws(() => validateSourceManifest({ kind: 'other', ...common }), /unsupported source kind/i);
});
