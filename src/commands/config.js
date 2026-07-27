// finchip config get / set / unset — manage ~/.finchip/config.json
import { loadConfig, saveConfig, getConfigPath } from '../config.js';
import { resolveChain } from '../chains.js';
import { CliError, emitFailure, emitResult, err, ok, inf, hd, sep, c } from '../utils.js';

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

function commandOptions(command) {
  return typeof command?.opts === 'function' ? command.opts() : command || {};
}

export function cmdConfigSet(key, value, command) {
  const options = commandOptions(command);
  if (key === 'privateKey' || key === 'privateKeyFile') {
    const error = new CliError(
      'PRIVATE_KEY_CONFIG_DISABLED',
      key === 'privateKey'
        ? 'Raw private keys cannot be stored in config. Run `finchip wallet create` or `finchip wallet use --file <path>`.'
        : 'Set wallet key files through `finchip wallet use --file <path>` so the file can be validated.',
      3,
    );
    if (options.json) emitFailure(options, error);
    else {
      err(`[${error.code}] ${error.message}`);
      process.exitCode = error.exitCode;
    }
    return;
  }
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
  } else {
    cfg[key] = value;
  }

  saveConfig(cfg);

  if (options.json) {
    emitResult(options, {
      ok: true,
      code: 'CONFIG_UPDATED',
      key,
      value: SENSITIVE_KEYS.has(key) ? null : cfg[key],
    }, () => {});
  } else if (SENSITIVE_KEYS.has(key)) {
    ok(`${key} updated (stored in ${getConfigPath()})`);
    if (key === 'pinataJwt') {
      console.log(`  ${c.yellow}⚠  pinataJwt is a masked legacy key; skill publish no longer reads it.${c.reset}`);
    }
  } else {
    ok(`${key}: ${prev ?? '(not set)'} → ${cfg[key]}`);
  }
  if (!options.json) console.log('');
}

export function cmdConfigUnset(key) {
  const cfg = loadConfig();
  delete cfg[key];
  saveConfig(cfg);
  ok(`${key} removed from config`);
  console.log('');
}
