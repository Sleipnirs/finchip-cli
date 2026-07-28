// FinChip CLI v0.3.0 — Config persistence (~/.finchip/config.json)
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_CHAIN } from './chains.js';
import { writePrivateTextFile } from './private-files.js';

const CONFIG_DIR  = join(homedir(), '.finchip');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  key:        null,                  // fc_key display form: "fc_xxxx"
  keyRaw:     null,                  // bytes32 raw: "0x<64hex>"
  wallet:     null,                  // agent wallet address (optional cache)
  chain:      DEFAULT_CHAIN,         // default chain ID
  rpc:        null,                  // custom RPC override (optional)
  privateKeyFile: null,              // Agent wallet key-file path
  privateKey: null,                  // legacy plaintext config compatibility
  label:      null,                  // default label for register
  pinataJwt:  null,                  // legacy key; retained so old secrets remain masked
};

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  writePrivateTextFile(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function getConfigPath() {
  return CONFIG_FILE;
}

export { WalletKeyError, resolveWalletPrivateKey } from './wallet.js';

// ── fc_key format conversion ─────────────────────────────────────────────────
/**
 * Normalise any fc_key input to bytes32 (0x + 64 hex).
 * Accepts:
 *   - "0x..." (66 chars) — full bytes32, returned as-is
 *   - "fc_..." (35 chars) — display key, padded out to bytes32
 *   - "fc_..." (>35 chars when full raw form is encoded as fc_+ 64hex) — accepted too
 */
export function keyToBytes32(input) {
  if (!input) throw new Error('Empty key');
  if (input.startsWith('0x') && input.length === 66) return input;
  if (input.startsWith('fc_')) {
    const hex = input.slice(3);
    if (hex.length === 32) return '0x' + hex.padEnd(64, '0');
    if (hex.length === 64) return '0x' + hex;
  }
  throw new Error(`Invalid key format: "${input}" (expected fc_<32 hex> or 0x<64 hex>)`);
}

/** Convert bytes32 raw key → display "fc_<first 32 hex chars>" */
export function keyToDisplay(raw) {
  if (!raw?.startsWith('0x')) return raw;
  return 'fc_' + raw.slice(2, 34);
}
