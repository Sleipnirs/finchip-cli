// FinChip CLI v0.3.0 — Config persistence (~/.finchip/config.json)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { c } from './utils.js';
import { DEFAULT_CHAIN } from './chains.js';

const CONFIG_DIR  = join(homedir(), '.finchip');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  key:        null,                  // fc_key display form: "fc_xxxx"
  keyRaw:     null,                  // bytes32 raw: "0x<64hex>"
  wallet:     null,                  // agent wallet address (optional cache)
  chain:      DEFAULT_CHAIN,         // default chain ID
  rpc:        null,                  // custom RPC override (optional)
  privateKey: null,                  // ⚠ env var preferred
  label:      null,                  // default label for register
  // Operational hints:
  pinataJwt:  null,                  // for `finchip prepare` IPFS uploads
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
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

export function getConfigPath() {
  return CONFIG_FILE;
}

// ── Private-key resolution (env var > config file) ──────────────────────────
export function getPrivateKey(cfg) {
  const key = process.env.FINCHIP_PRIVATE_KEY || cfg.privateKey;
  if (!key) {
    console.error('');
    console.error(`${c.red} ✗${c.reset} No private key found.`);
    console.error(`${c.gray}   Set env var: ${c.reset}export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY`);
    console.error(`${c.gray}   Or run:      ${c.reset}finchip config set privateKey 0xYOUR_PRIVATE_KEY`);
    console.error('');
    process.exit(1);
  }
  return key.startsWith('0x') ? key : `0x${key}`;
}

// ── Pinata JWT resolution ───────────────────────────────────────────────────
export function getPinataJwt(cfg) {
  return process.env.PINATA_JWT || cfg.pinataJwt || null;
}

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
