import { loadConfig, getPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { ADDRESSES, MARKET_ABI, CHIP_REGISTRY_ABI, CHIP_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtWei, fmtChain, c } from '../utils.js';

export async function cmdTradeList(options) {
  const cfg      = loadConfig();
  const chainId  = parseInt(options.chain || cfg.chain || 56);
  const limit    = parseInt(options.limit || '20');
  const symbol   = chainId === 56 ? 'BNB' : 'ETH';
  const mktAddr  = ADDRESSES.market[chainId];

  if (!mktAddr) { err(`Unsupported chain: ${chainId}`); process.exit(1); }

  hd(`FinChip Trade Market — ${fmtChain(chainId)}`);
  sep();

  const client = getPublicClient(chainId, cfg.rpc);

  let total;
  try {
    total = await client.readContract({ address: mktAddr, abi: MARKET_ABI, functionName: 'listingCount' });
  } catch (e) {
    err(`Failed to fetch market: ${e.shortMessage || e.message}`);
    process.exit(1);
  }

  if (total === 0n) {
    inf('No listings on this chain yet.');
    return;
  }

  const toFetch = Number(total < BigInt(limit) ? total : BigInt(limit));
  inf(`${total} total listing(s). Fetching latest ${toFetch}…`);
  console.log('');

  // Fetch from newest to oldest
  const ids = Array.from({ length: toFetch }, (_, i) => BigInt(Number(total) - 1 - i));
  const listings = await Promise.all(
    ids.map(id =>
      client.readContract({ address: mktAddr, abi: MARKET_ABI, functionName: 'getListing', args: [id] })
        .then(l => ({ ...l, id }))
        .catch(() => null)
    )
  );

  const active = listings.filter(l => l && l.active);

  if (!active.length) {
    inf('No active listings.');
    return;
  }

  // Enrich with slug
  const regAddr = ADDRESSES.chipRegistry[chainId];
  await Promise.all(active.map(async l => {
    try {
      const [name] = await Promise.all([
        client.readContract({ address: l.chipAddr, abi: CHIP_ABI, functionName: 'name' }).catch(() => fmtAddr(l.chipAddr)),
      ]);
      l.chipName = name;
    } catch { l.chipName = fmtAddr(l.chipAddr); }
  }));

  const colW = [6, 28, 14, 12, 12];
  const header = ['ID','CHIP','PRICE','QTY','SELLER'].map((h,i)=>h.padEnd(colW[i])).join('  ');
  console.log(`${c.bold}${c.gray}  ${header}${c.reset}`);
  sep();

  for (const l of active) {
    const row = [
      String(l.id).padEnd(colW[0]),
      `${c.cyan}${l.chipName.slice(0,26).padEnd(colW[1])}${c.reset}`,
      fmtWei(l.pricePerUnit, symbol).padEnd(colW[2]),
      String(l.quantity).padEnd(colW[3]),
      fmtAddr(l.seller).padEnd(colW[4]),
    ].join('  ');
    console.log(`  ${row}`);
  }
  console.log('');
  inf(`${active.length} active listing(s)`);
  inf(`Buy:    finchip trade buy --id <id> --qty <qty>`);
  inf(`List:   finchip trade sell --slug <slug> --price <price> --qty <qty>`);
  console.log('');
}

export async function cmdTradeBuy(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);
  const id      = options.id;
  const qty     = parseInt(options.qty || '1');

  if (!id) { err('--id is required. Get listing IDs from: finchip trade list'); process.exit(1); }

  const mktAddr    = ADDRESSES.market[chainId];
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient  = getPublicClient(chainId, cfg.rpc);
  const symbol     = chainId === 56 ? 'BNB' : 'ETH';

  const listing = await pubClient.readContract({
    address: mktAddr, abi: MARKET_ABI, functionName: 'getListing', args: [BigInt(id)],
  });

  if (!listing.active) { err(`Listing ${id} is not active.`); process.exit(1); }

  const totalCost = listing.pricePerUnit * BigInt(qty);

  hd('FinChip CLI — trade buy');
  sep();
  inf(`listing:  #${id}`);
  inf(`chip:     ${listing.chipAddr}`);
  inf(`qty:      ${qty}`);
  inf(`total:    ${fmtWei(totalCost, symbol)}`);
  console.log('');
  inf('Sending buyListing…');

  try {
    const hash = await walletClient.writeContract({
      address: mktAddr, abi: MARKET_ABI, functionName: 'buyListing',
      args: [BigInt(id), BigInt(qty)],
      value: totalCost,
    });
    ok(`tx submitted: ${hash}`);
    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`Purchased · block ${receipt.blockNumber}`);
    } else {
      err('Transaction reverted'); process.exit(1);
    }
  } catch (e) {
    err(`Buy failed: ${e.shortMessage || e.message?.split('\n')[0]}`);
    process.exit(1);
  }
  console.log('');
}

export async function cmdTradeSell(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);
  const { slug, price, qty } = options;

  if (!slug || !price) { err('--slug and --price are required'); process.exit(1); }

  const mktAddr    = ADDRESSES.market[chainId];
  const regAddr    = ADDRESSES.chipRegistry[chainId];
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient  = getPublicClient(chainId, cfg.rpc);
  const { parseEther } = await import('viem');
  const symbol     = chainId === 56 ? 'BNB' : 'ETH';

  const chipAddr = await pubClient.readContract({
    address: regAddr, abi: CHIP_REGISTRY_ABI, functionName: 'resolve', args: [slug],
  });
  if (!chipAddr || chipAddr === '0x0000000000000000000000000000000000000000') {
    err(`Slug not found: ${slug}`); process.exit(1);
  }

  const creator = await pubClient.readContract({
    address: chipAddr, abi: CHIP_ABI, functionName: 'creator',
  });

  const priceWei = parseEther(String(price));
  const quantity = BigInt(qty || 1);

  hd('FinChip CLI — trade sell');
  sep();
  inf(`slug:  ${slug}`);
  inf(`price: ${fmtWei(priceWei, symbol)} per unit`);
  inf(`qty:   ${quantity}`);

  // Check approval
  const { CHIP_ABI: _abi } = await import('../contracts.js');
  const approved = await pubClient.readContract({
    address: chipAddr, abi: _abi, functionName: 'isApprovedForAll',
    args: [account.address, mktAddr],
  }).catch(() => false);

  if (!approved) {
    inf('Approving market to transfer tokens…');
    const approveHash = await walletClient.writeContract({
      address: chipAddr, abi: _abi, functionName: 'setApprovalForAll',
      args: [mktAddr, true],
    });
    await pubClient.waitForTransactionReceipt({ hash: approveHash });
    ok('Approval confirmed');
  }

  const hash = await walletClient.writeContract({
    address: mktAddr, abi: MARKET_ABI, functionName: 'listToken',
    args: [chipAddr, creator, 1n, quantity, priceWei, 0],
  });
  ok(`tx submitted: ${hash}`);
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'success') {
    ok(`Listed · block ${receipt.blockNumber}`);
    inf(`Run: finchip trade list  to see your listing`);
  } else {
    err('Transaction reverted'); process.exit(1);
  }
  console.log('');
}

export async function cmdTradeCancel(options) {
  const cfg        = loadConfig();
  const chainId    = parseInt(options.chain || cfg.chain || 56);
  const mktAddr    = ADDRESSES.market[chainId];
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient  = getPublicClient(chainId, cfg.rpc);

  if (!options.id) { err('--id is required'); process.exit(1); }

  const hash = await walletClient.writeContract({
    address: mktAddr, abi: MARKET_ABI, functionName: 'cancelListing',
    args: [BigInt(options.id)],
  });
  ok(`tx submitted: ${hash}`);
  await pubClient.waitForTransactionReceipt({ hash });
  ok(`Listing #${options.id} cancelled`);
  console.log('');
}
