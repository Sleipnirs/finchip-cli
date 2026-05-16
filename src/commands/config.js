// finchip config get / set / unset — manage ~/.finchip/config.json
import { loadConfig, saveConfig, getConfigPath } from '../config.js';
import { resolveChain } from '../chains.js';
import { ok, inf, hd, sep, c } from '../utils.js';

const SENSITIVE_KEYS = new Set(['privateKey', 'pinataJwt']);

export function cmdConfigGet(key) {
  const cfg = loadConfig();
  if (key) {
    const val = cfg[key];
    if (val === undefined || val === null) {
      console.log('(not set)');
    } else if (SENSITIVE_KEYS.has(key) && val) {
      console.log('•••••• (set; use --reveal to show)');
    } else {
      console.log(val);
    }
    return;
  }
  hd('FinChip CLI — config');
  sep();
  inf(`file: ${getConfigPath()}`);
  console.log('');
  const maxKey = Math.max(...Object.keys(cfg).map(k => k.length));
  for (const [k, v] of Object.entries(cfg)) {
    const padded = k.padEnd(maxKey);
    if (SENSITIVE_KEYS.has(k) && v) {
      console.log(`  ${c.gray}${padded}${c.reset}  ${c.yellow}••••••${c.reset} (set)`);
    } else {
      console.log(`  ${c.gray}${padded}${c.reset}  ${v ?? '(not set)'}`);
    }
  }
  console.log('');
}

export function cmdConfigSet(key, value) {
  const cfg  = loadConfig();
  const prev = cfg[key];

  // Type coercion / validation per key
  if (key === 'chain') {
    try {
      cfg[key] = resolveChain(value).id;
    } catch (e) {
      console.error(`${c.red} ✗${c.reset} ${e.message}`);
      process.exit(1);
    }
  } else if (key === 'privateKey') {
    let v = value.startsWith('0x') ? value : `0x${value}`;
    if (v.length !== 66) {
      console.error(`${c.red} ✗${c.reset} privateKey must be 0x + 64 hex chars`);
      process.exit(1);
    }
    cfg[key] = v;
  } else {
    cfg[key] = value;
  }

  saveConfig(cfg);

  if (SENSITIVE_KEYS.has(key)) {
    ok(`${key} updated (stored in ${getConfigPath()})`);
    console.log(`  ${c.yellow}⚠  For private keys, prefer env vars:${c.reset}`);
    if (key === 'privateKey') console.log(`     export FINCHIP_PRIVATE_KEY=0x...`);
    if (key === 'pinataJwt')  console.log(`     export PINATA_JWT=...`);
  } else {
    ok(`${key}: ${prev ?? '(not set)'} → ${cfg[key]}`);
  }
  console.log('');
}

export function cmdConfigUnset(key) {
  const cfg = loadConfig();
  delete cfg[key];
  saveConfig(cfg);
  ok(`${key} removed from config`);
  console.log('');
}
