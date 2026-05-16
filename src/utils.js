// FinChip CLI v0.3.0 — Terminal formatting utilities
import { getSymbol, getShortName, getExplorer } from './chains.js';

export const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  gray:   '\x1b[90m',
};

// ANSI-friendly output helpers
export const ok  = (s) => console.log(`${c.green} ✓${c.reset} ${s}`);
export const err = (s) => console.error(`${c.red} ✗${c.reset} ${s}`);
export const wrn = (s) => console.log(`${c.yellow} ⚠${c.reset} ${s}`);
export const inf = (s) => console.log(`${c.gray}   ${s}${c.reset}`);
export const hd  = (s) => console.log(`\n${c.bold}${s}${c.reset}`);
export const sep = ()  => console.log(`${c.gray}${'─'.repeat(64)}${c.reset}`);

// ── Formatters ───────────────────────────────────────────────────────────────
export function fmtAddr(addr) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return '0x0…0000';
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function fmtFullAddr(addr) {
  return addr;
}

/**
 * Format wei amount with chain-appropriate symbol.
 * Auto-resolves symbol from chainId (BNB / ETH / etc).
 */
export function fmtWei(wei, chainId) {
  const symbol = getSymbol(chainId);
  if (wei === 0n || wei === 0) return `0 ${symbol}`;
  const v = Number(wei) / 1e18;
  if (v < 1e-9)   return `${v.toExponential(2)} ${symbol}`;
  if (v < 0.001)  return `${v.toFixed(6)} ${symbol}`;
  if (v < 1)      return `${v.toFixed(4)} ${symbol}`;
  return `${v.toFixed(2)} ${symbol}`;
}

export function fmtUsdc(amount, decimals = 6) {
  const v = Number(amount) / Math.pow(10, decimals);
  return `${v.toFixed(2)} USDC`;
}

export function fmtPerms(bitmask) {
  const perms = [];
  if (bitmask & 0x01) perms.push('READ');
  if (bitmask & 0x02) perms.push('ACQUIRE');
  if (bitmask & 0x04) perms.push('LAUNCH');
  if (bitmask & 0x08) perms.push('TRADE');
  return perms.length ? perms.join(' | ') : 'NONE';
}

export function fmtChain(chainId) {
  return getShortName(chainId);
}

export function fmtWalletType(t) {
  return ['', 'EOA', 'AA', 'Multisig'][t] || `Type ${t}`;
}

export function fmtBool(b) {
  return b ? `${c.green}✓ true${c.reset}` : `${c.red}✗ false${c.reset}`;
}

export function fmtExplorerLink(addr, chainId) {
  const e = getExplorer(chainId);
  return e ? `${e}/address/${addr}` : addr;
}

export function fmtTxLink(hash, chainId) {
  const e = getExplorer(chainId);
  return e ? `${e}/tx/${hash}` : hash;
}

// ── Output mode (text vs json) ───────────────────────────────────────────────
let _outputMode = 'text';

export function setOutputMode(mode) {
  _outputMode = (mode === 'json') ? 'json' : 'text';
}

export function isJsonMode() {
  return _outputMode === 'json';
}

/**
 * Emit a structured result.
 * In text mode: pretty-printed using the inline helpers.
 * In json mode: a single JSON line on stdout.
 *
 * @param {object} result   { type, ok, data }
 */
export function emit(result) {
  if (_outputMode === 'json') {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  // In text mode, the caller already pretty-printed; this is a no-op.
}

// Format duration in human-friendly form
export function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
