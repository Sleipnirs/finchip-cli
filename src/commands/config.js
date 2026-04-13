import { loadConfig, saveConfig, getConfigPath } from '../config.js';
import { ok, inf, hd, sep, c } from '../utils.js';

export function cmdConfigGet(key) {
  const cfg = loadConfig();
  if (key) {
    const val = cfg[key];
    if (val === undefined) { console.log(`(not set)`); }
    else { console.log(val); }
  } else {
    hd('FinChip CLI — config');
    sep();
    inf(`file: ${getConfigPath()}`);
    console.log('');
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'privateKey' && v) {
        console.log(`  ${c.gray}${k.padEnd(12)}${c.reset}  ${c.yellow}••••••${c.reset} (set)`);
      } else {
        console.log(`  ${c.gray}${k.padEnd(12)}${c.reset}  ${v ?? '(not set)'}`);
      }
    }
    console.log('');
  }
}

export function cmdConfigSet(key, value) {
  const cfg  = loadConfig();
  const prev = cfg[key];

  // Type coercion
  if (key === 'chain') cfg[key] = parseInt(value);
  else                 cfg[key] = value;

  saveConfig(cfg);

  if (key === 'privateKey') {
    ok(`privateKey updated (stored in ${getConfigPath()})`);
    console.log(`  ${c.yellow}⚠  Prefer: export FINCHIP_PRIVATE_KEY=0x... (env var is safer)${c.reset}`);
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
