import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MINIMUM_NODE_MAJOR,
  buildUnsupportedNodeError,
  isSupportedNodeVersion,
} from '../src/runtime-version.js';

test('runtime version guard rejects Node 21 and accepts Node 22', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 22);
  assert.equal(isSupportedNodeVersion('v21.7.3'), false);
  assert.equal(isSupportedNodeVersion('22.0.0'), true);
  assert.equal(isSupportedNodeVersion('v24.13.0'), true);
});

test('runtime version guard fails closed for malformed versions', () => {
  assert.equal(isSupportedNodeVersion('not-a-version'), false);
  assert.equal(isSupportedNodeVersion(''), false);
  assert.equal(isSupportedNodeVersion(null), false);
});

test('unsupported runtime JSON has a stable machine-readable contract', () => {
  assert.deepEqual(buildUnsupportedNodeError('v20.19.6'), {
    ok: false,
    code: 'UNSUPPORTED_NODE_VERSION',
    required: '>=22.0.0',
    current: 'v20.19.6',
    message: 'FinChip CLI requires Node.js 22 or newer.',
  });
});

test('bootstrap contains no static imports before the runtime guard', async () => {
  const source = await readFile(new URL('../bin/finchip.js', import.meta.url), 'utf8');
  const staticImport = /^\s*import(?!\s*\()/m;

  assert.doesNotMatch(source, staticImport);
  assert.match(source, /await import\(['"]\.\.\/src\/cli\.js['"]\)/);
});
