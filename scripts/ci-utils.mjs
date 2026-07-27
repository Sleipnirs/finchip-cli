import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  win32,
} from 'node:path';

const REQUIRED_PACKAGE_FILES = [
  'LICENSE',
  'README.md',
  'package.json',
  'npm-shrinkwrap.json',
  'bin/finchip.js',
  'src/cli.js',
];

function pathFrom(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

async function walkJavaScript(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkJavaScript(entryPath, output);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      output.push(entryPath);
    }
  }
}

export async function collectJavaScriptFiles(root) {
  const rootPath = pathFrom(root);
  const files = [];
  await walkJavaScript(join(rootPath, 'bin'), files);
  await walkJavaScript(join(rootPath, 'src'), files);
  return files;
}

export function assertAllowedPackageFiles(paths) {
  const normalized = paths.map((path) => path.replaceAll('\\', '/'));
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!normalized.includes(required)) {
      throw new Error(`Required file is missing from npm package: ${required}`);
    }
  }

  for (const path of normalized) {
    const segments = path.split('/');
    const basename = segments.at(-1).toLowerCase();
    const forbidden = (
      segments.some((segment) => [
        '.finchip',
        '.github',
        'artifacts',
        'scripts',
        'test',
        'tests',
        'test-support',
      ].includes(segment.toLowerCase()))
      || basename === '.env'
      || basename.startsWith('.env.')
      || ['credentials.json', 'publish-state.json'].includes(basename)
      || /\.(?:diff|key|log|patch|pem|tgz)$/.test(basename)
    );
    if (forbidden) throw new Error(`Unexpected file in npm package: ${path}`);

    const allowed = (
      path === 'LICENSE'
      || path === 'README.md'
      || path === 'package.json'
      || path === 'npm-shrinkwrap.json'
      || path.startsWith('bin/')
      || path.startsWith('src/')
    );
    if (!allowed) throw new Error(`Unexpected file in npm package: ${path}`);
  }
}

export function installedFinchipBin(prefix, platform = process.platform) {
  return platform === 'win32'
    ? win32.join(prefix, 'finchip.cmd')
    : join(prefix, 'bin', 'finchip');
}

export function installedFinchipInvocation(prefix, args, options = {}) {
  const {
    platform = process.platform,
    comSpec = process.env.ComSpec || 'cmd.exe',
  } = options;
  const bin = installedFinchipBin(prefix, platform);

  if (platform !== 'win32') return { command: bin, args };
  if (!args.every((arg) => /^--[a-z-]+$/.test(arg))) {
    throw new Error('Windows installed CLI smoke arguments must be fixed long options.');
  }
  return {
    command: comSpec,
    args: ['/d', '/c', `call "${bin}" ${args.join(' ')}`],
    windowsVerbatimArguments: true,
  };
}

export function runInstalledFinchip(prefix, args, options = {}) {
  const invocation = installedFinchipInvocation(prefix, args);
  return runCommand(invocation.command, invocation.args, {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export function parseUnsupportedRuntimeError(stderr) {
  const jsonLine = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));

  if (!jsonLine) throw new Error('Node runtime guard did not emit valid JSON.');

  let parsed;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    throw new Error('Node runtime guard did not emit valid JSON.');
  }

  if (parsed?.code !== 'UNSUPPORTED_NODE_VERSION') {
    throw new Error('Node runtime guard did not emit UNSUPPORTED_NODE_VERSION.');
  }
  return parsed;
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });

  if (result.error) throw result.error;
  return result;
}

export function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function resolveTrustedNpmCli(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('npm_execpath must be an absolute path.');
  }

  let npmCli;
  try {
    npmCli = realpathSync(value);
  } catch {
    throw new Error('npm_execpath must resolve to an existing file.');
  }
  if (!statSync(npmCli).isFile()) {
    throw new Error('npm_execpath must resolve to a regular file.');
  }

  const binDirectory = dirname(npmCli);
  if (basename(npmCli) !== 'npm-cli.js' || basename(binDirectory) !== 'bin') {
    throw new Error('npm_execpath must resolve to npm/bin/npm-cli.js.');
  }

  const packageRoot = dirname(binDirectory);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw new Error('npm_execpath must belong to a readable npm package.');
  }

  const npmBin = typeof manifest.bin === 'object' && manifest.bin !== null
    ? manifest.bin.npm
    : manifest.bin;
  if (manifest.name !== 'npm' || String(npmBin || '').replaceAll('\\', '/') !== 'bin/npm-cli.js') {
    throw new Error('npm_execpath must belong to a package named npm with the expected CLI entry.');
  }

  return npmCli;
}

export function npmInvocation(args, options = {}) {
  const {
    platform = process.platform,
    execPath = process.execPath,
    npmExecPath = process.env.npm_execpath,
  } = options;

  if (npmExecPath) {
    const npmCli = resolveTrustedNpmCli(npmExecPath);
    return {
      command: execPath,
      args: [npmCli, ...args],
      shell: false,
    };
  }

  return {
    command: npmExecutable(platform),
    args,
    shell: platform === 'win32',
  };
}

export function runNpm(args, options = {}) {
  const invocation = npmInvocation(args);
  return runCommand(invocation.command, invocation.args, {
    ...options,
    shell: invocation.shell,
  });
}
