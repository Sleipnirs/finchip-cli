import { loadConfig } from '../config.js';
import { getPublicClient } from '../client.js';
import { ADDRESSES, CHIP_REGISTRY_ABI, CHIP_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtWei, fmtChain, c } from '../utils.js';

export async function cmdMarketList(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);
  const limit   = parseInt(options.limit || '20');
  const filter  = options.category?.toLowerCase();

  const regAddr = ADDRESSES.chipRegistry[chainId];
  if (!regAddr) { err(`Unsupported chain: ${chainId}`); process.exit(1); }

  const symbol = chainId === 56 ? 'BNB' : 'ETH';

  hd(`FinChip Market — ${fmtChain(chainId)}`);
  sep();
  inf('Fetching chip registry…');

  const client = getPublicClient(chainId, cfg.rpc);

  let slugs;
  try {
    slugs = await client.readContract({
      address: regAddr, abi: CHIP_REGISTRY_ABI, functionName: 'allSlugs',
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
  const results = [];

  // Batch resolve addresses
  const addresses = await Promise.all(
    toFetch.map(slug =>
      client.readContract({ address: regAddr, abi: CHIP_REGISTRY_ABI, functionName: 'resolve', args: [slug] })
        .catch(() => null)
    )
  );

  // Fetch chip metadata in parallel (5 at a time)
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    const addrs = addresses.slice(i, i + 5);

    const batchResults = await Promise.all(
      batch.map(async (slug, j) => {
        const addr = addrs[j];
        if (!addr || addr === '0x0000000000000000000000000000000000000000') return null;
        try {
          const [name, price, totalMinted, maxSupply, category] = await Promise.all([
            client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'name' }).catch(() => slug),
            client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'licensePrice' }).catch(() => 0n),
            client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'totalMinted' }).catch(() => 0n),
            client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'maxSupply' }).catch(() => 0n),
            client.readContract({ address: addr, abi: CHIP_ABI, functionName: 'category' }).catch(() => ''),
          ]);
          return { slug, addr, name, price, totalMinted, maxSupply, category };
        } catch { return null; }
      })
    );
    results.push(...batchResults.filter(Boolean));
  }

  // Filter by category if requested
  const filtered = filter
    ? results.filter(r => r.category.toLowerCase().includes(filter))
    : results;

  if (!filtered.length) {
    inf(`No chips found${filter ? ` in category "${filter}"` : ''}.`);
    return;
  }

  // Print table
  const colW = [32, 12, 12, 14];
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
      fmtWei(chip.price, symbol).padEnd(colW[1]),
      supply.padEnd(colW[2]),
      (chip.category || '—').padEnd(colW[3]),
    ].join('  ');
    console.log(`  ${row}`);
  }

  console.log('');
  inf(`Showing ${filtered.length} of ${slugs.length} chips · chain: ${fmtChain(chainId)}`);
  inf(`Acquire: finchip acquire --slug <slug>`);
  console.log('');
}

export async function cmdMarketSearch(options) {
  // Alias: market search = market list with category filter
  await cmdMarketList({ ...options, limit: options.limit || '50' });
}
