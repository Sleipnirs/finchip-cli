import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

import { CliError } from './utils.js';

export const MAX_WALLET_KEY_FILE_BYTES = 4096;

let legacyWarningEmitted = false;

export class WalletKeyError extends CliError {
  constructor(code, message, exitCode = 3, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'WalletKeyError';
  }
}

export function defaultWalletPath(home = homedir()) {
  return join(home, '.finchip', 'wallets', 'agent.key');
}

export function resolveWalletPath(value, home = homedir()) {
  if (!value) return defaultWalletPath(home);
  const expanded = value === '~'
    ? home
    : value.startsWith('~/') || value.startsWith('~\\')
      ? join(home, value.slice(2))
      : value;
  return resolve(expanded);
}

export function normalizeWalletPrivateKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X')
    ? trimmed.slice(2)
    : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new WalletKeyError(
      'WALLET_KEY_INVALID',
      'Wallet key must contain exactly 32 bytes of hexadecimal data.',
    );
  }
  return `0x${hex.toLowerCase()}`;
}

export function readWalletPrivateKey(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new WalletKeyError(
        'WALLET_KEY_FILE_NOT_FOUND',
        `Wallet key file was not found: ${path}`,
        3,
        { path },
      );
    }
    throw new WalletKeyError(
      'WALLET_KEY_FILE_UNREADABLE',
      `Wallet key file could not be read: ${path}`,
      3,
      { path },
    );
  }
  if (size > MAX_WALLET_KEY_FILE_BYTES) {
    throw new WalletKeyError(
      'WALLET_KEY_INVALID',
      `Wallet key file exceeds ${MAX_WALLET_KEY_FILE_BYTES} bytes.`,
      3,
      { path },
    );
  }
  try {
    return normalizeWalletPrivateKey(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof WalletKeyError) {
      error.details = { ...error.details, path };
      throw error;
    }
    throw new WalletKeyError(
      'WALLET_KEY_FILE_UNREADABLE',
      `Wallet key file could not be read: ${path}`,
      3,
      { path },
    );
  }
}

export function deprecatedWalletEnvironmentVariables(env = process.env) {
  return ['FINCHIP_PRIVATE_KEY', 'FINCHIP_PRIVATE_KEY_FILE']
    .filter(variable => typeof env[variable] === 'string' && env[variable].trim());
}

export function rejectDisabledWalletEnvironment(env = process.env) {
  const variables = deprecatedWalletEnvironmentVariables(env);
  if (variables.length) {
    throw new WalletKeyError(
      'WALLET_ENV_DISABLED',
      `${variables.join(', ')} ${variables.length === 1 ? 'is' : 'are'} deprecated and disabled. `
      + 'Remove the deprecated environment variable before running login or signing commands, '
      + 'then select a wallet with `finchip wallet use --file <path>`.',
      3,
      { variable: variables[0], variables },
    );
  }
}

function legacyWarning(warn) {
  if (legacyWarningEmitted) return;
  legacyWarningEmitted = true;
  warn(
    'FinChip is using legacy config.privateKey. Run `finchip wallet migrate` '
    + 'or `finchip wallet use --file <path>`.',
  );
}

export function inspectWalletSource(cfg = {}, {
  env = process.env,
  required = true,
  warn = message => console.error(`Warning: ${message}`),
} = {}) {
  rejectDisabledWalletEnvironment(env);
  if (cfg.privateKeyFile) {
    const path = resolveWalletPath(cfg.privateKeyFile);
    const privateKey = readWalletPrivateKey(path);
    return {
      source: 'config-file',
      path,
      privateKey,
      address: privateKeyToAccount(privateKey).address,
    };
  }
  if (cfg.privateKey) {
    const privateKey = normalizeWalletPrivateKey(cfg.privateKey);
    legacyWarning(warn);
    return {
      source: 'legacy-config',
      path: null,
      privateKey,
      address: privateKeyToAccount(privateKey).address,
    };
  }
  if (!required) return null;
  throw new WalletKeyError(
    'WALLET_KEY_MISSING',
    'No Agent wallet is configured. Run `finchip wallet create` or `finchip wallet use --file <path>`.',
  );
}

export function resolveWalletPrivateKey(cfg = {}, options = {}) {
  return inspectWalletSource(cfg, options)?.privateKey ?? null;
}
