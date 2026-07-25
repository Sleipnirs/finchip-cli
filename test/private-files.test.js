import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';

import { resolveWindowsUserSid } from '../src/private-files.js';

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
