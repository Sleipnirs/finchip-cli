import test from 'node:test';
import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';

import {
  assertAllowedPackageFiles,
  collectJavaScriptFiles,
  installedFinchipBin,
  installedFinchipInvocation,
  npmInvocation,
  parseUnsupportedRuntimeError,
} from '../scripts/ci-utils.mjs';

test('syntax gate discovers every shipped JavaScript subtree', async () => {
  const files = await collectJavaScriptFiles(new URL('..', import.meta.url));
  const normalized = files.map((file) => file.replaceAll('\\', '/'));

  assert.ok(files.length > 40);
  assert.ok(normalized.some((file) => file.endsWith('/bin/finchip.js')));
  assert.ok(normalized.some((file) => file.endsWith('/src/cli.js')));
  assert.ok(normalized.some((file) => file.endsWith('/src/a2a-client.js')));
});

test('package gate accepts only the public CLI payload', () => {
  assert.doesNotThrow(() => assertAllowedPackageFiles([
    'LICENSE',
    'README.md',
    'package.json',
    'npm-shrinkwrap.json',
    'bin/finchip.js',
    'src/cli.js',
  ]));

  for (const forbidden of [
    'test/runtime-version.test.js',
    'test-support/private-permissions.js',
    'scripts/check-package.mjs',
    '.github/workflows/test.yml',
    '.env',
    'secret.key',
    'publish-state.json',
    'fix.patch',
    'src/.env.production',
    'src/private.pem',
    'src/fix.patch',
    'src/publish-state.json',
    'bin/debug.log',
  ]) {
    assert.throws(
      () => assertAllowedPackageFiles([
        'LICENSE',
        'README.md',
        'package.json',
        'npm-shrinkwrap.json',
        'bin/finchip.js',
        'src/cli.js',
        forbidden,
      ]),
      /Unexpected file in npm package/,
    );
  }
});

test('package gate requires the bootstrap, CLI body, and published shrinkwrap', () => {
  assert.throws(
    () => assertAllowedPackageFiles(['LICENSE', 'README.md', 'package.json', 'bin/finchip.js', 'src/cli.js']),
    /npm-shrinkwrap\.json/,
  );
});

test('global npm bin path is platform aware', () => {
  assert.equal(installedFinchipBin('/tmp/prefix', 'linux'), join('/tmp/prefix', 'bin', 'finchip'));
  assert.equal(installedFinchipBin('C:\\prefix', 'win32'), win32.join('C:\\prefix', 'finchip.cmd'));
  assert.deepEqual(
    installedFinchipInvocation('C:\\prefix', ['--help'], {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', 'call "C:\\prefix\\finchip.cmd" --help'],
      windowsVerbatimArguments: true,
    },
  );
});

test('npm scripts invoke the npm CLI through Node instead of spawning npm.cmd', () => {
  assert.deepEqual(
    npmInvocation(['pack'], {
      platform: 'win32',
      execPath: 'C:\\Node\\node.exe',
      npmExecPath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js',
    }),
    {
      command: 'C:\\Node\\node.exe',
      args: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', 'pack'],
      shell: false,
    },
  );
});

test('Node 20 guard parser accepts only the stable unsupported-runtime error', () => {
  const parsed = parseUnsupportedRuntimeError(JSON.stringify({
    ok: false,
    code: 'UNSUPPORTED_NODE_VERSION',
    required: '>=22.0.0',
    current: 'v20.19.6',
    message: 'FinChip CLI requires Node.js 22 or newer.',
  }));

  assert.equal(parsed.code, 'UNSUPPORTED_NODE_VERSION');
  assert.throws(() => parseUnsupportedRuntimeError('SyntaxError: Unexpected token'), /valid JSON/);
  assert.throws(
    () => parseUnsupportedRuntimeError(JSON.stringify({ code: 'OTHER' })),
    /UNSUPPORTED_NODE_VERSION/,
  );
});
