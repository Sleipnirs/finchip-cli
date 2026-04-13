export const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  blue:   '\x1b[34m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

export const ok  = (s) => console.log(`${c.green} ✓${c.reset} ${s}`);
export const err = (s) => console.error(`${c.red} ✗${c.reset} ${s}`);
export const inf = (s) => console.log(`${c.gray}   ${s}${c.reset}`);
export const hd  = (s) => console.log(`\n${c.bold}${s}${c.reset}`);
export const sep = ()  => console.log(`${c.gray}${'─'.repeat(60)}${c.reset}`);

export function fmtAddr(addr) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function fmtWei(wei, symbol = 'ETH') {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return 'free';
  return `${eth.toFixed(eth < 0.001 ? 6 : 4)} ${symbol}`;
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
  return chainId === 56 ? 'BSC' : chainId === 8453 ? 'Base' : `Chain ${chainId}`;
}
