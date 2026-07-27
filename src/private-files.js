import {
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, win32 } from 'node:path';

const SYSTEM_SID = 'S-1-5-18';
const securedDirectories = new Set();
let cachedWindowsUserSid = null;

function runWindowsCommand(command, args, description, spawn = spawnSync) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout;
}

export function resolveWindowsUserSid({
  systemRoot = process.env.SystemRoot,
  spawn = spawnSync,
} = {}) {
  // Do not resolve whoami through PATH: Git Bash/MSYS can select its Unix
  // whoami, which rejects Windows /user arguments and makes ACL writes fail.
  const whoamiPath = win32.join(systemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  const output = runWindowsCommand(
    whoamiPath,
    ['/user', '/fo', 'csv', '/nh'],
    'Could not resolve the current Windows account',
    spawn,
  );
  const match = output.match(/"(S-\d+(?:-\d+)+)"\s*$/im);
  if (!match) throw new Error('Could not parse the current Windows account SID.');
  return match[1];
}

function currentWindowsUserSid() {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  cachedWindowsUserSid = resolveWindowsUserSid();
  return cachedWindowsUserSid;
}

function restrictWindowsAcl(target, directory, reset) {
  const userSid = currentWindowsUserSid();
  const rights = directory ? '(OI)(CI)(F)' : '(F)';

  // Replace inherited or pre-existing grants with an explicit DACL for only
  // the current account and Windows SYSTEM. Each command is checked so a
  // credential write fails closed instead of silently leaving a broad ACL.
  if (reset) runWindowsCommand('icacls', [target, '/reset'], `Could not reset ACL for ${target}`);
  runWindowsCommand('icacls', [target, '/inheritance:r'], `Could not disable ACL inheritance for ${target}`);
  runWindowsCommand(
    'icacls',
    [target, '/grant:r', `*${userSid}:${rights}`, `*${SYSTEM_SID}:${rights}`],
    `Could not restrict ACL for ${target}`,
  );
}

export function restrictPrivatePath(target, { directory = false, reset = true } = {}) {
  if (process.platform === 'win32') {
    restrictWindowsAcl(target, directory, reset);
    return;
  }
  chmodSync(target, directory ? 0o700 : 0o600);
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (securedDirectories.has(path)) return;
  restrictPrivatePath(path, { directory: true });
  securedDirectories.add(path);
}

export function writePrivateTextFile(path, text) {
  const dir = dirname(path);
  ensurePrivateDirectory(dir);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // The temporary file is newly created inside a directory whose ACL was
    // already restricted, so it has no pre-existing explicit grants to reset.
    restrictPrivatePath(temp, { reset: false });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

export class PrivateFileCreateError extends Error {
  constructor(message, { path, cleanupRequired = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PrivateFileCreateError';
    this.path = path;
    this.cleanupRequired = cleanupRequired;
  }
}

/**
 * Create a new private text file without ever replacing an existing target.
 *
 * Unlike writePrivateTextFile, this writes directly to the final path with
 * O_EXCL. A temp-file rename is intentionally unsuitable for wallet keys:
 * POSIX rename replaces an existing destination and could destroy access to a
 * funded wallet.
 */
export function writeNewPrivateTextFile(path, text, {
  protectDirectory = true,
  restrict = restrictPrivatePath,
  remove = target => rmSync(target, { force: true }),
} = {}) {
  const dir = dirname(path);
  if (protectDirectory) ensurePrivateDirectory(dir);
  else mkdirSync(dir, { recursive: true, mode: 0o700 });

  let created = false;
  let descriptor = null;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, text, { encoding: 'utf8' });
    closeSync(descriptor);
    descriptor = null;
    restrict(path, { reset: false });
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Cleanup below remains the authoritative fail-closed action.
      }
      descriptor = null;
    }
    // Preserve native EEXIST so callers can distinguish an occupied wallet
    // path from a storage-hardening failure.
    if (!created) throw error;

    let cleanupRequired = false;
    try {
      remove(path);
    } catch {
      cleanupRequired = true;
    }
    throw new PrivateFileCreateError(
      cleanupRequired
        ? 'Private file hardening failed and the created file could not be removed.'
        : `Private file hardening failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      { path, cleanupRequired, cause: error },
    );
  }
}

export function writePrivateBinaryFile(path, value, { force = false } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  if (existsSync(path) && !force) {
    throw new Error(`Output already exists: ${path}. Use --force to overwrite it.`);
  }
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
    restrictPrivatePath(temp, { reset: false });
    try {
      renameSync(temp, path);
    } catch (error) {
      if (!force || !existsSync(path) || !['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      rmSync(path, { force: true });
      renameSync(temp, path);
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}
