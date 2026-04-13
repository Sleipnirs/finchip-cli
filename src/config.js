import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR  = join(homedir(), '.finchip');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  key:        null,   // fc_key (display form: fc_xxxxx)
  keyRaw:     null,   // bytes32 raw key (0x...)
  wallet:     null,   // agent wallet address
  chain:      56,     // default chain ID (BSC)
  rpc:        null,   // custom RPC override
  privateKey: null,   // WARNING: stored locally, use env var preferred
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

// Resolve private key: env var takes priority over config file
export function getPrivateKey(cfg) {
  const key = process.env.FINCHIP_PRIVATE_KEY || cfg.privateKey;
  if (!key) {
    console.error('\n  ✗ No private key found.');
    console.error('  Set env var: export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY');
    console.error('  Or run: finchip config set privateKey 0xYOUR_PRIVATE_KEY\n');
    process.exit(1);
  }
  return key.startsWith('0x') ? key : `0x${key}`;
}

// Convert display fc_key to bytes32
export function keyToBytes32(fcKey) {
  // fc_key display format: "fc_" + 32 hex chars
  // raw format: "0x" + 64 hex chars
  if (fcKey.startsWith('0x') && fcKey.length === 66) return fcKey;
  if (fcKey.startsWith('fc_')) {
    // display key is first 32 hex chars, we need full 64
    // stored raw in config as keyRaw
    throw new Error('Pass the full raw key (0x...) or use --key flag with raw bytes32');
  }
  return fcKey;
}
