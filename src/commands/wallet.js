import {
  existsSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  generatePrivateKey,
  privateKeyToAccount,
} from 'viem/accounts';

import { loadConfig, saveConfig } from '../config.js';
import {
  PrivateFileCreateError,
  writeNewPrivateTextFile,
} from '../private-files.js';
import {
  WalletKeyError,
  defaultWalletPath,
  inspectWalletSource,
  normalizeWalletPrivateKey,
  readWalletPrivateKey,
  resolveWalletPath,
} from '../wallet.js';
import {
  emitFailure,
  emitResult,
  hd,
  inf,
  ok,
  sep,
  wrn,
} from '../utils.js';

function storageError(message, path, cleanupRequired = false) {
  return new WalletKeyError(
    'WALLET_KEY_STORAGE_FAILED',
    message,
    5,
    { path, cleanupRequired },
  );
}

function mapCreateError(error, path) {
  if (error?.code === 'EEXIST') {
    return new WalletKeyError(
      'WALLET_FILE_EXISTS',
      `Wallet key file already exists and was not changed: ${path}`,
      3,
      { path },
    );
  }
  if (error instanceof PrivateFileCreateError) {
    return storageError(error.message, path, error.cleanupRequired);
  }
  return storageError(
    `Could not create the wallet key file: ${error instanceof Error ? error.message : 'unknown error'}`,
    path,
  );
}

function protectParentFor(path, customPath) {
  return !customPath || !existsSync(dirname(path));
}

function createKeyFile(path, privateKey, customPath) {
  try {
    writeNewPrivateTextFile(path, `${privateKey}\n`, {
      protectDirectory: protectParentFor(path, customPath),
    });
  } catch (error) {
    throw mapCreateError(error, path);
  }
}

function removeCreatedKeyAfterFailure(path, error) {
  let cleanupRequired = false;
  try {
    rmSync(path, { force: true });
  } catch {
    cleanupRequired = true;
  }
  throw storageError(
    cleanupRequired
      ? 'Wallet selection failed and the newly created key file could not be removed.'
      : `Wallet selection failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    path,
    cleanupRequired,
  );
}

function fail(options, error) {
  emitFailure(options, error, {
    code: 'WALLET_KEY_STORAGE_FAILED',
    message: 'Wallet operation failed.',
  });
}

export function createAgentWallet(options = {}, dependencies = {}) {
  const path = resolveWalletPath(options.file);
  const privateKey = (dependencies.generatePrivateKey || generatePrivateKey)();
  const address = privateKeyToAccount(privateKey).address;
  createKeyFile(path, privateKey, Boolean(options.file));
  const cfg = (dependencies.loadConfig || loadConfig)();
  try {
    (dependencies.saveConfig || saveConfig)({
      ...cfg,
      privateKeyFile: path,
      wallet: address,
    });
  } catch (error) {
    removeCreatedKeyAfterFailure(path, error);
  }
  return {
    ok: true,
    code: 'WALLET_CREATED',
    address,
    path,
    source: 'config-file',
  };
}

export async function cmdWalletCreate(options = {}) {
  try {
    const result = createAgentWallet(options);
    emitResult(options, result, () => {
      hd('FinChip CLI — Agent wallet');
      sep();
      ok('Created and selected a dedicated Agent wallet');
      inf(`address: ${result.address}`);
      inf(`key file: ${result.path}`);
      wrn('This file contains an unencrypted private key. Keep it private and fund it only with a small Agent budget.');
    });
  } catch (error) {
    fail(options, error);
  }
}

export async function cmdWalletUse(options = {}) {
  try {
    const path = resolveWalletPath(options.file);
    const privateKey = readWalletPrivateKey(path);
    const address = privateKeyToAccount(privateKey).address;
    try {
      const cfg = loadConfig();
      saveConfig({ ...cfg, privateKeyFile: path, wallet: address });
    } catch (error) {
      throw storageError(
        `Could not save the selected wallet: ${error instanceof Error ? error.message : 'unknown error'}`,
        path,
      );
    }
    const result = {
      ok: true,
      code: 'WALLET_SELECTED',
      address,
      path,
      source: 'config-file',
    };
    emitResult(options, result, () => {
      ok('Selected Agent wallet');
      inf(`address: ${address}`);
      inf(`key file: ${path}`);
      inf('The provided key file was not copied and its permissions were not changed.');
    });
  } catch (error) {
    fail(options, error);
  }
}

export async function cmdWalletStatus(options = {}) {
  try {
    const selected = inspectWalletSource(loadConfig());
    const result = {
      ok: true,
      code: 'WALLET_STATUS',
      configured: true,
      address: selected.address,
      source: selected.source,
      path: selected.path,
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — Agent wallet');
      sep();
      ok('Wallet configured');
      inf(`address: ${selected.address}`);
      inf(`source:  ${selected.source}`);
      if (selected.path) inf(`key file: ${selected.path}`);
    });
  } catch (error) {
    fail(options, error);
  }
}

export function migrateLegacyWallet(options = {}, dependencies = {}) {
  const cfg = dependencies.cfg || loadConfig();
  if (!cfg.privateKey) {
    throw new WalletKeyError(
      'WALLET_MIGRATION_UNAVAILABLE',
      'No legacy config.privateKey is available to migrate.',
    );
  }
  const legacyKey = normalizeWalletPrivateKey(cfg.privateKey);
  const address = privateKeyToAccount(legacyKey).address;
  const path = resolveWalletPath(options.file || defaultWalletPath());
  let reusedExistingFile = false;

  if (existsSync(path)) {
    const existingKey = readWalletPrivateKey(path);
    const existingAddress = privateKeyToAccount(existingKey).address;
    if (existingAddress.toLowerCase() !== address.toLowerCase()) {
      throw new WalletKeyError(
        'WALLET_FILE_EXISTS',
        `A different wallet key file already exists and was not changed: ${path}`,
        3,
        { path },
      );
    }
    reusedExistingFile = true;
  } else {
    createKeyFile(path, legacyKey, Boolean(options.file));
  }

  const verifiedAddress = privateKeyToAccount(readWalletPrivateKey(path)).address;
  if (verifiedAddress.toLowerCase() !== address.toLowerCase()) {
    throw storageError('The migrated key file did not reproduce the legacy wallet address.', path);
  }

  const next = { ...cfg, privateKeyFile: path, wallet: address };
  delete next.privateKey;
  try {
    (dependencies.saveConfig || saveConfig)(next);
  } catch {
    throw new WalletKeyError(
      'WALLET_MIGRATION_INCOMPLETE',
      'The key file is ready, but config could not be updated. Re-run `finchip wallet migrate`.',
      5,
      { path, address, reusedExistingFile },
    );
  }

  return {
    ok: true,
    code: 'WALLET_MIGRATED',
    address,
    path,
    reusedExistingFile,
    legacyConfigRemoved: true,
    securityWarning: 'The old plaintext may remain in disk history, backups, editors, or cloud sync.',
  };
}

export async function cmdWalletMigrate(options = {}) {
  try {
    const result = migrateLegacyWallet(options);
    emitResult(options, result, () => {
      ok('Migrated legacy config.privateKey to an Agent wallet key file');
      inf(`address: ${result.address}`);
      inf(`key file: ${result.path}`);
      wrn('Rewriting config does not securely erase copies from disk history, backups, editors, or cloud sync.');
      wrn('If this wallet holds meaningful assets, treat the old plaintext as potentially exposed and use a new wallet.');
    });
  } catch (error) {
    fail(options, error);
  }
}
