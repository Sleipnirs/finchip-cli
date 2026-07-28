import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WalletKeyError,
  inspectWalletSource,
  normalizeWalletPrivateKey,
  resolveWalletPrivateKey,
} from '../src/wallet.js';
import {
  createAgentWallet,
  migrateLegacyWallet,
} from '../src/commands/wallet.js';

const ENV_KEY = `0x${'11'.repeat(32)}`;
const ENV_FILE_KEY = `0x${'22'.repeat(32)}`;
const CONFIG_FILE_KEY = `0x${'33'.repeat(32)}`;
const LEGACY_KEY = `0x${'44'.repeat(32)}`;

test('wallet key normalization accepts whitespace and an optional 0x prefix', () => {
  assert.equal(normalizeWalletPrivateKey(` \n${ENV_KEY}\r\n`), ENV_KEY);
  assert.equal(normalizeWalletPrivateKey(ENV_KEY.slice(2)), ENV_KEY);
  assert.throws(
    () => normalizeWalletPrivateKey('not-a-private-key'),
    error => error instanceof WalletKeyError && error.code === 'WALLET_KEY_INVALID',
  );
});

test('wallet resolution follows env, env file, config file, then legacy config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-wallet-resolution-'));
  const envPath = join(dir, 'env.key');
  const configPath = join(dir, 'config.key');
  writeFileSync(envPath, `${ENV_FILE_KEY}\n`);
  writeFileSync(configPath, CONFIG_FILE_KEY.slice(2));
  const cfg = {
    privateKeyFile: configPath,
    privateKey: LEGACY_KEY,
  };

  assert.equal(resolveWalletPrivateKey(cfg, {
    env: { FINCHIP_PRIVATE_KEY: ENV_KEY, FINCHIP_PRIVATE_KEY_FILE: envPath },
  }), ENV_KEY);
  assert.equal(resolveWalletPrivateKey(cfg, {
    env: { FINCHIP_PRIVATE_KEY_FILE: envPath },
  }), ENV_FILE_KEY);
  assert.equal(resolveWalletPrivateKey(cfg, { env: {} }), CONFIG_FILE_KEY);

  const warnings = [];
  assert.equal(resolveWalletPrivateKey({ privateKey: LEGACY_KEY }, {
    env: {},
    warn: message => warnings.push(message),
  }), LEGACY_KEY);
  assert.equal(resolveWalletPrivateKey({ privateKey: LEGACY_KEY }, {
    env: {},
    warn: message => warnings.push(message),
  }), LEGACY_KEY);
  assert.equal(warnings.length, 1);
});

test('higher-priority invalid wallet sources fail closed instead of falling back', () => {
  assert.throws(
    () => resolveWalletPrivateKey({ privateKey: LEGACY_KEY }, {
      env: { FINCHIP_PRIVATE_KEY: 'invalid' },
    }),
    error => error instanceof WalletKeyError && error.code === 'WALLET_KEY_INVALID',
  );
});

test('missing wallet source has a stable error and optional inspection remains offline', () => {
  assert.throws(
    () => resolveWalletPrivateKey({}, { env: {} }),
    error => error instanceof WalletKeyError && error.code === 'WALLET_KEY_MISSING',
  );
  assert.equal(inspectWalletSource({}, { env: {}, required: false }), null);
});

test('wallet creation removes the new key when config selection fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-wallet-config-failure-'));
  const path = join(dir, 'agent.key');
  assert.throws(
    () => createAgentWallet({ file: path }, {
      loadConfig: () => ({}),
      saveConfig() {
        throw new Error('config ACL failure');
      },
    }),
    error => error.code === 'WALLET_KEY_STORAGE_FAILED'
      && error.details.cleanupRequired === false,
  );
  assert.equal(existsSync(path), false);
});

test('incomplete legacy migration leaves a reusable key file and never removes the legacy input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finchip-wallet-migrate-incomplete-'));
  const path = join(dir, 'agent.key');
  const cfg = { privateKey: LEGACY_KEY, chain: 56 };

  assert.throws(
    () => migrateLegacyWallet({ file: path }, {
      cfg,
      saveConfig() {
        throw new Error('config ACL failure');
      },
    }),
    error => error.code === 'WALLET_MIGRATION_INCOMPLETE'
      && error.details.path === path
      && error.details.reusedExistingFile === false,
  );
  assert.equal(existsSync(path), true);
  assert.equal(cfg.privateKey, LEGACY_KEY);

  let saved;
  const resumed = migrateLegacyWallet({ file: path }, {
    cfg,
    saveConfig(next) {
      saved = next;
    },
  });
  assert.equal(resumed.reusedExistingFile, true);
  assert.equal(saved.privateKey, undefined);
  assert.equal(saved.privateKeyFile, path);
});
