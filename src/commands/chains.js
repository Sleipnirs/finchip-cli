// finchip chains — list all supported chains
import { listChains } from '../chains.js';
import { AGENT_REGISTRY } from '../protocol.js';
import { hd, sep, inf, c } from '../utils.js';

export function cmdChains() {
  hd('FinChip CLI — supported chains');
  sep();

  const chains = listChains();
  const colW = [10, 22, 8, 7, 50];
  const header = ['CHAIN ID', 'NAME', 'SHORT', 'SYMBOL', 'AGENT REGISTRY']
    .map((h, i) => h.padEnd(colW[i])).join('  ');
  console.log(`${c.bold}${c.gray}  ${header}${c.reset}`);
  sep();

  for (const ch of chains) {
    const reg = AGENT_REGISTRY[ch.id] || '(not configured)';
    const row = [
      String(ch.id).padEnd(colW[0]),
      `${c.cyan}${ch.name.padEnd(colW[1])}${c.reset}`,
      ch.short.padEnd(colW[2]),
      ch.symbol.padEnd(colW[3]),
      reg.padEnd(colW[4]),
    ].join('  ');
    console.log(`  ${row}`);
  }

  console.log('');
  inf(`Use any chain ID with --chain <id>, e.g.: finchip market list --chain 8453`);
  inf(`All other protocol addresses (Factory, Market, FeeRouter, ChipRegistry)`);
  inf(`are discovered at runtime via AgentRegistry.getProtocolExtended() —`);
  inf(`run \`finchip protocol info --chain <id>\` to see them per-chain.`);
  console.log('');
}
