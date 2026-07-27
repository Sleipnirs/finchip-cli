import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseUnsupportedRuntimeError,
  runCommand,
  runInstalledFinchip,
  runNpm,
} from './ci-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major !== 20) throw new Error(`Node 20 guard check must run on Node 20, received ${process.version}.`);

for (const file of ['bin/finchip.js', 'src/runtime-version.js']) {
  const checked = runCommand(process.execPath, ['--check', file], { cwd: root });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || checked.stdout || '');
    throw new Error(`Node 20 could not parse ${file}.`);
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'finchip-node20-check-'));

function requireSuccess(result, label) {
  if (result.status === 0) return;
  process.stderr.write(result.stderr || result.stdout || '');
  throw new Error(`${label} failed with exit code ${result.status}.`);
}

try {
  const pack = runNpm([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], { cwd: root });
  requireSuccess(pack, 'npm pack');
  const packageInfo = JSON.parse(pack.stdout)[0];
  const tarball = join(temporaryRoot, basename(packageInfo.filename));
  const prefix = join(temporaryRoot, 'global-prefix');

  const install = runNpm([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--engine-strict=false',
    tarball,
  ], { cwd: root });
  requireSuccess(install, 'Node 20 global tarball install');

  const result = runInstalledFinchip(prefix, ['--json'], { cwd: root });
  if (result.status !== 1) {
    throw new Error(`Unsupported runtime guard exited with ${result.status}; expected 1.`);
  }
  if (/SyntaxError|WebCrypto|ERR_MODULE_NOT_FOUND|globalThis\.crypto/.test(result.stderr)) {
    throw new Error('Unsupported runtime guard leaked a parser or application-module failure.');
  }

  const error = parseUnsupportedRuntimeError(result.stderr);
  if (error.current !== process.version || error.required !== '>=22.0.0') {
    throw new Error('Unsupported runtime guard reported the wrong runtime contract.');
  }

  process.stdout.write(`Node 20 guard check passed for ${process.version}.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
