import {
  chmodSync,
  existsSync,
  mkdirSync,
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
