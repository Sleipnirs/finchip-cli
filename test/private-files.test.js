import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { join } from 'node:path';

import {
  PrivateFileCreateError,
  resolveWindowsUserSid,
  writeNewPrivateTextFile,
} from '../src/private-files.js';

test('Windows SID lookup invokes the System32 whoami.exe absolute path', () => {
  const calls = [];
  const sid = resolveWindowsUserSid({
    systemRoot: 'D:\\Windows',
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        error: null,
        stderr: '',
        stdout: '"WORKSTATION\\\\agent","S-1-5-21-111-222-333-1001"\r\n',
      };
    },
  });

  assert.equal(sid, 'S-1-5-21-111-222-333-1001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, win32.join('D:\\Windows', 'System32', 'whoami.exe'));
  assert.notEqual(calls[0].command, 'whoami');
  assert.deepEqual(calls[0].args, ['/user', '/fo', 'csv', '/nh']);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Windows SID lookup falls back to C:\\Windows when SystemRoot is absent', () => {
  let invokedCommand;
  resolveWindowsUserSid({
    systemRoot: '',
    spawn(command) {
      invokedCommand = command;
      return {
        status: 0,
        error: null,
        stderr: '',
        stdout: '"WORKSTATION\\\\agent","S-1-5-21-1-2-3-1001"\n',
      };
    },
  });

  assert.equal(invokedCommand, 'C:\\Windows\\System32\\whoami.exe');
});

test('exclusive private-file creation never replaces an existing target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-private-exclusive-'));
  const target = join(dir, 'agent.key');
  writeFileSync(target, 'existing-funded-wallet');

  assert.throws(
    () => writeNewPrivateTextFile(target, 'replacement', { protectDirectory: false }),
    error => error?.code === 'EEXIST',
  );
  assert.equal(readFileSync(target, 'utf8'), 'existing-funded-wallet');
});

test('exclusive private-file creation removes the final file when hardening fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-private-cleanup-'));
  const target = join(dir, 'agent.key');

  assert.throws(
    () => writeNewPrivateTextFile(target, 'ephemeral', {
      protectDirectory: false,
      restrict() {
        throw new Error('ACL unavailable');
      },
    }),
    error => error instanceof PrivateFileCreateError
      && error.cleanupRequired === false
      && /ACL unavailable/.test(error.message),
  );
  assert.equal(existsSync(target), false);
});

test('exclusive private-file creation reports when cleanup also fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-private-cleanup-failed-'));
  const target = join(dir, 'agent.key');

  assert.throws(
    () => writeNewPrivateTextFile(target, 'ephemeral', {
      protectDirectory: false,
      restrict() {
        throw new Error('ACL unavailable');
      },
      remove() {
        throw new Error('file locked');
      },
    }),
    error => error instanceof PrivateFileCreateError
      && error.cleanupRequired === true
      && error.path === target,
  );
  assert.equal(existsSync(target), true);
  rmSync(target, { force: true });
});

test('exclusive creation does not harden an existing custom parent directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-private-custom-parent-'));
  const target = join(dir, 'agent.key');
  const restricted = [];
  writeNewPrivateTextFile(target, 'ephemeral', {
    protectDirectory: false,
    restrict(path, options) {
      restricted.push({ path, options });
    },
  });
  assert.deepEqual(restricted, [{ path: target, options: { reset: false } }]);
});
