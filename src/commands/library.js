// finchip library — show all chips the wallet holds across all 5 chains
// Walks: AgentRegistry.allSlugs() → resolve each → balanceOf(wallet)
import { loadConfig, getPrivateKey } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient } from '../client.js';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AGENT_REGISTRY, AGENT_REGISTRY_ABI,
  CHIP_REGISTRY_ABI, CHIP_ABI, CHIP_721_ABI, IFACE_ID,
} from '../protocol.js';
import { listChains } from '../chains.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtChain, fmtWei, c } from '../utils.js';

export async function cmdLibrary(options) {
  const cfg    = loadConfig();
  // Wallet address: explicit > derive from private key > from config
  let walletAddress = options.wallet || cfg.wallet;
  if (!walletAddress) {
    try {
      const pk = getPrivateKey(cfg);
      walletAddress = privateKeyToAccount(pk).address;
    } catch {
      err('No wallet address found. Pass --wallet 0x... or set FINCHIP_PRIVATE_KEY');
      process.exit(1);
    }
  }

  // Allow filtering by single chain
  const filterChain = options.chain ? parseInt(options.chain) : null;
  const chainsToScan = filterChain
    ? listChains().filter(ch => ch.id === filterChain)
    : listChains();

  hd(`FinChip Library — ${fmtAddr(walletAddress)}`);
  sep();
  inf(`wallet: ${walletAddress}`);
  inf(`scanning ${chainsToScan.length} chain(s)…`);
  console.log('');

  let grandTotal1155 = 0n;
  let grandTotal721  = 0;

  for (const ch of chainsToScan) {
    process.stdout.write(`${c.bold}${ch.name} (${ch.id})${c.reset}\n`);

    let proto;
    try {
      proto = await resolveProtocol(ch.id, cfg.rpc);
    } catch (e) {
      console.log(`  ${c.red}✗ discovery failed: ${e.shortMessage || e.message}${c.reset}\n`);
      continue;
    }

    const client = getPublicClient(ch.id, cfg.rpc);

    // Get all slugs
    let slugs;
    try {
      slugs = await client.readContract({
        address: proto.chipRegistry, abi: CHIP_REGISTRY_ABI, functionName: 'allSlugs',
      });
    } catch (e) {
      console.log(`  ${c.gray}— no chips registered on this chain${c.reset}\n`);
      continue;
    }
    if (!slugs.length) {
      console.log(`  ${c.gray}— no chips registered on this chain${c.reset}\n`);
      continue;
    }

    // Resolve to addresses in parallel
    const addrs = await Promise.all(slugs.map(slug =>
      client.readContract({
        address: proto.chipRegistry, abi: CHIP_REGISTRY_ABI,
        functionName: 'resolve', args: [slug],
      }).then(addr => ({ slug, addr })).catch(() => null)
    ));

    // For each chip: detect ERC-1155/721 + check balance
    const holdings = [];
    for (let i = 0; i < addrs.length; i += 10) {
      const batch = addrs.slice(i, i + 10).filter(Boolean);
      const batchResults = await Promise.all(batch.map(async ({ slug, addr }) => {
        if (!addr || addr === '0x0000000000000000000000000000000000000000') return null;

        // Detect standard via ERC-165
        let is721 = false;
        try {
          is721 = await client.readContract({
            address: addr, abi: CHIP_ABI,
            functionName: 'supportsInterface', args: [IFACE_ID.ERC721],
          });
        } catch { is721 = false; }

        try {
          if (is721) {
            const [bal, name, price] = await Promise.all([
              client.readContract({ address: addr, abi: CHIP_721_ABI, functionName: 'balanceOf',  args: [walletAddress] }).catch(() => 0n),
              client.readContract({ address: addr, abi: CHIP_721_ABI, functionName: 'name'        }).catch(() => slug),
              client.readContract({ address: addr, abi: CHIP_721_ABI, functionName: 'forkPrice'   }).catch(() => 0n),
            ]);
            if (bal === 0n) return null;
            return { slug, addr, name, balance: bal, price, kind: 'ERC-721' };
          } else {
            const [bal, name, price] = await Promise.all([
              client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'balanceOf', args: [walletAddress, 1n] }).catch(() => 0n),
              client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'name'        }).catch(() => slug),
              client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'licensePrice'}).catch(() => 0n),
            ]);
            if (bal === 0n) return null;
            return { slug, addr, name, balance: bal, price, kind: 'ERC-1155' };
          }
        } catch { return null; }
      }));
      holdings.push(...batchResults.filter(Boolean));
    }

    if (!holdings.length) {
      console.log(`  ${c.gray}— no holdings on this chain (${slugs.length} chips scanned)${c.reset}\n`);
      continue;
    }

    const colW = [30, 9, 6, 14];
    const header = ['SLUG', 'STANDARD', 'QTY', 'PRICE'].map((h, i) => h.padEnd(colW[i])).join('  ');
    console.log(`  ${c.gray}${header}${c.reset}`);
    for (const h of holdings) {
      const row = [
        `${c.cyan}${h.slug.slice(0, 28).padEnd(colW[0])}${c.reset}`,
        h.kind.padEnd(colW[1]),
        String(h.balance).padEnd(colW[2]),
        fmtWei(h.price, ch.id).padEnd(colW[3]),
      ].join('  ');
      console.log(`  ${row}`);
      if (h.kind === 'ERC-721') grandTotal721  += Number(h.balance);
      else                       grandTotal1155 += h.balance;
    }
    console.log('');
  }

  sep();
  ok(`Total: ${grandTotal1155} ERC-1155 license(s) + ${grandTotal721} ERC-721 fork(s)`);
  console.log('');
}
