// finchip market list / search — browse chips via discovery + ChipRegistry
import { loadConfig } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient } from '../client.js';
import { CHIP_REGISTRY_ABI, CHIP_ABI } from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtWei, fmtChain, c } from '../utils.js';

export async function cmdMarketList(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  const limit  = parseInt(options.limit || '20');
  const filter = options.category?.toLowerCase();

  hd(`FinChip Market — ${fmtChain(chain.id)}`);
  sep();

  const proto  = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  const client = getPublicClient(chain.id, cfg.rpc);

  inf('Fetching chip registry…');
  let slugs;
  try {
    slugs = await client.readContract({
      address: proto.chipRegistry, abi: CHIP_REGISTRY_ABI, functionName: 'allSlugs',
    });
  } catch (e) {
    err(`Failed to fetch market: ${e.shortMessage || e.message?.split('\n')[0]}`);
    process.exit(1);
  }

  if (!slugs.length) {
    inf('No chips found on this chain.');
    return;
  }

  inf(`${slugs.length} chip(s) registered. Fetching details (limit: ${limit})…`);
  console.log('');

  const toFetch = slugs.slice(0, limit);

  // Resolve addresses in parallel
  const addresses = await Promise.all(toFetch.map(slug =>
    client.readContract({
      address: proto.chipRegistry, abi: CHIP_REGISTRY_ABI,
      functionName: 'resolve', args: [slug],
    }).catch(() => null)
  ));

  // Fetch chip metadata in batches of 5
  const results = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    const addrs = addresses.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(async (slug, j) => {
      const addr = addrs[j];
      if (!addr || addr === '0x0000000000000000000000000000000000000000') return null;
      try {
        const [name, price, totalMinted, maxSupply, category] = await Promise.all([
          client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'name'         }).catch(() => slug),
          client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'licensePrice' }).catch(() => 0n),
          client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'totalMinted'  }).catch(() => 0n),
          client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'maxSupply'    }).catch(() => 0n),
          client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'category'     }).catch(() => ''),
        ]);
        return { slug, addr, name, price, totalMinted, maxSupply, category };
      } catch { return null; }
    }));
    results.push(...batchResults.filter(Boolean));
  }

  const filtered = filter
    ? results.filter(r => r.category.toLowerCase().includes(filter))
    : results;

  if (!filtered.length) {
    inf(`No chips found${filter ? ` in category "${filter}"` : ''}.`);
    return;
  }

  const colW = [32, 14, 12, 14];
  const header = [
    'SLUG'.padEnd(colW[0]),
    'PRICE'.padEnd(colW[1]),
    'MINTED'.padEnd(colW[2]),
    'CATEGORY'.padEnd(colW[3]),
  ].join('  ');
  console.log(`${c.bold}${c.gray}  ${header}${c.reset}`);
  sep();

  for (const chip of filtered) {
    const supply = chip.maxSupply > 0n
      ? `${chip.totalMinted}/${chip.maxSupply}`
      : `${chip.totalMinted}/∞`;
    const row = [
      `${c.cyan}${chip.slug.padEnd(colW[0])}${c.reset}`,
      fmtWei(chip.price, chain.id).padEnd(colW[1]),
      supply.padEnd(colW[2]),
      (chip.category || '—').padEnd(colW[3]),
    ].join('  ');
    console.log(`  ${row}`);
  }

  console.log('');
  inf(`Showing ${filtered.length} of ${slugs.length} chips · ${fmtChain(chain.id)}`);
  inf(`Acquire: finchip acquire --slug <slug>`);
  console.log('');
}

export async function cmdMarketSearch(options) {
  await cmdMarketList({ ...options, limit: options.limit || '50' });
}
