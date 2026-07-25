import test from 'node:test';
import assert from 'node:assert/strict';

import { cmdChains } from '../src/commands/chains.js';

test('chains help points to the existing protocol command', () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  try {
    cmdChains();
  } finally {
    console.log = originalLog;
  }

  const text = output.join('\n');
  assert.match(text, /finchip protocol --chain <id>/);
  assert.doesNotMatch(text, /finchip protocol info/);
});
