import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAllowedPackageFiles,
  runInstalledFinchip,
  runNpm,
} from './ci-utils.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'finchip-package-check-'));

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

  const packResult = JSON.parse(pack.stdout);
  const packageInfo = packResult[0];
  if (!packageInfo?.filename || !Array.isArray(packageInfo.files)) {
    throw new Error('npm pack returned a malformed JSON manifest.');
  }
  assertAllowedPackageFiles(packageInfo.files.map((file) => file.path));

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
    tarball,
  ], { cwd: root });
  requireSuccess(install, 'global tarball install');

  const help = runInstalledFinchip(prefix, ['--help'], { cwd: root });
  requireSuccess(help, 'installed finchip --help');
  if (!help.stdout.includes('FinChip Protocol CLI')) {
    throw new Error('Installed finchip --help did not contain the CLI description.');
  }

  const version = runInstalledFinchip(prefix, ['--version'], { cwd: root });
  requireSuccess(version, 'installed finchip --version');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (version.stdout.trim() !== packageJson.version) {
    throw new Error(`Installed CLI version mismatch: expected ${packageJson.version}, got ${version.stdout.trim()}.`);
  }

  process.stdout.write(`Package check passed for ${packageInfo.files.length} files on ${process.platform}.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
