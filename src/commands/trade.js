// finchip trade list / buy / sell / cancel — FinChipMarket V2 client
import { loadConfig, getPrivateKey } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient, getWalletClient, parseEther } from '../client.js';
import {
  MARKET_ABI, CHIP_REGISTRY_ABI,
  CHIP_ABI, CHIP_721_ABI, IFACE_ID,
} from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtWei, fmtChain, fmtTxLink, c } from '../utils.js';

// ── List active listings ────────────────────────────────────────────────────
export async function cmdTradeList(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  const limit  = parseInt(options.limit || '20');

  hd(`FinChip Trade Market — ${fmtChain(chain.id)}`);
  sep();

  const proto  = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  const client = getPublicClient(chain.id, cfg.rpc);

  let total;
  try {
    total = await client.readContract({
      address: proto.market, abi: MARKET_ABI, functionName: 'listingCount',
    });
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

  const ids = Array.from({ length: toFetch }, (_, i) => BigInt(Number(total) - 1 - i));
  const listings = await Promise.all(ids.map(id =>
    client.readContract({
      address: proto.market, abi: MARKET_ABI,
      functionName: 'getListing', args: [id],
    }).then(l => ({ ...l, id })).catch(() => null)
  ));

  const active = listings.filter(l => l && l.active);
  if (!active.length) {
    inf('No active listings.');
    return;
  }

  // Enrich with chip name
  await Promise.all(active.map(async l => {
    try {
      const name = await client.readContract({
        address: l.chipAddr, abi: CHIP_ABI, functionName: 'name',
      }).catch(() => fmtAddr(l.chipAddr));
      l.chipName = name;
    } catch { l.chipName = fmtAddr(l.chipAddr); }
  }));

  const colW = [6, 6, 28, 14, 10, 14];
  const header = ['ID', 'TYPE', 'CHIP', 'PRICE', 'QTY', 'SELLER']
    .map((h, i) => h.padEnd(colW[i])).join('  ');
  console.log(`${c.bold}${c.gray}  ${header}${c.reset}`);
  sep();

  for (const l of active) {
    const typeStr = l.standard === 1 ? '721' : '1155';
    const row = [
      String(l.id).padEnd(colW[0]),
      typeStr.padEnd(colW[1]),
      `${c.cyan}${l.chipName.slice(0, 26).padEnd(colW[2])}${c.reset}`,
      fmtWei(l.pricePerUnit, chain.id).padEnd(colW[3]),
      String(l.quantity).padEnd(colW[4]),
      fmtAddr(l.seller).padEnd(colW[5]),
    ].join('  ');
    console.log(`  ${row}`);
  }

  console.log('');
  inf(`${active.length} active listing(s)`);
  inf(`Buy:    finchip trade buy --id <id> [--qty <qty>]`);
  inf(`List:   finchip trade sell --slug <slug> --price <price> [--qty <qty>] [--fork]`);
  console.log('');
}

// ── Buy a listing ───────────────────────────────────────────────────────────
export async function cmdTradeBuy(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  const id     = options.id;
  const qty    = BigInt(options.qty || '1');

  if (id === undefined) {
    err('--id is required. Get listing IDs from: finchip trade list');
    process.exit(1);
  }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  const listing = await pubClient.readContract({
    address: proto.market, abi: MARKET_ABI,
    functionName: 'getListing', args: [BigInt(id)],
  });

  if (!listing.active) { err(`Listing ${id} is not active.`); process.exit(1); }

  const totalCost = listing.pricePerUnit * qty;

  hd('FinChip CLI — trade buy');
  sep();
  inf(`listing:  #${id}`);
  inf(`chip:     ${listing.chipAddr}`);
  inf(`type:     ${listing.standard === 1 ? 'ERC-721' : 'ERC-1155'}`);
  inf(`qty:      ${qty}`);
  inf(`total:    ${fmtWei(totalCost, chain.id)}`);
  console.log('');
  inf('Sending buyListing…');

  try {
    const hash = await walletClient.writeContract({
      address: proto.market, abi: MARKET_ABI, functionName: 'buyListing',
      args: [BigInt(id), qty], value: totalCost,
    });
    ok(`tx submitted: ${hash}`);
    inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
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

// ── Sell (list a token) ─────────────────────────────────────────────────────
export async function cmdTradeSell(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  const { slug, price, qty } = options;
  const forceFork = !!options.fork;

  if (!slug || !price) { err('--slug and --price are required'); process.exit(1); }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  // Resolve chip
  const chipAddr = await pubClient.readContract({
    address: proto.chipRegistry, abi: CHIP_REGISTRY_ABI,
    functionName: 'resolve', args: [slug],
  });
  if (!chipAddr || chipAddr === '0x0000000000000000000000000000000000000000') {
    err(`Slug not found: ${slug}`); process.exit(1);
  }

  // Detect standard
  let isFork = forceFork;
  if (!forceFork) {
    try {
      isFork = await pubClient.readContract({
        address: chipAddr, abi: CHIP_ABI,
        functionName: 'supportsInterface', args: [IFACE_ID.ERC721],
      });
    } catch { isFork = false; }
  }
  const standardNum = isFork ? 1 : 0;
  const chipAbi     = isFork ? CHIP_721_ABI : CHIP_ABI;

  // Read creator (for royalty routing)
  const creator = await pubClient.readContract({
    address: chipAddr, abi: chipAbi, functionName: 'creator',
  });

  const priceWei = parseEther(String(price));
  const quantity = isFork ? 1n : BigInt(qty || 1);

  // For ERC-721 listings, tokenId must be supplied by user — must be one they own
  const tokenId = isFork
    ? (options.tokenId !== undefined ? BigInt(options.tokenId)
       : (() => { err('--token-id is required when listing ERC-721 fork. Find your tokens via: finchip library'); process.exit(1); })())
    : 1n;

  hd('FinChip CLI — trade sell');
  sep();
  inf(`slug:    ${slug}`);
  inf(`chip:    ${chipAddr}`);
  inf(`type:    ${isFork ? 'ERC-721' : 'ERC-1155'}`);
  inf(`price:   ${fmtWei(priceWei, chain.id)} per unit`);
  inf(`qty:     ${quantity}`);
  if (isFork) inf(`tokenId: ${tokenId}`);

  // ── Approval ────────────────────────────────────────────────────────────
  const approved = await pubClient.readContract({
    address: chipAddr, abi: chipAbi, functionName: 'isApprovedForAll',
    args: [account.address, proto.market],
  }).catch(() => false);

  if (!approved) {
    inf('Approving market to transfer tokens…');
    const approveHash = await walletClient.writeContract({
      address: chipAddr, abi: chipAbi, functionName: 'setApprovalForAll',
      args: [proto.market, true],
    });
    await pubClient.waitForTransactionReceipt({ hash: approveHash });
    ok('Approval confirmed');
  }

  // ── List ────────────────────────────────────────────────────────────────
  inf('Sending listToken…');
  const hash = await walletClient.writeContract({
    address: proto.market, abi: MARKET_ABI, functionName: 'listToken',
    args: [chipAddr, creator, tokenId, quantity, priceWei, standardNum],
  });
  ok(`tx submitted: ${hash}`);
  inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'success') {
    ok(`Listed · block ${receipt.blockNumber}`);
    inf(`Run: finchip trade list  to see your listing`);
  } else {
    err('Transaction reverted'); process.exit(1);
  }
  console.log('');
}

// ── Cancel listing ──────────────────────────────────────────────────────────
export async function cmdTradeCancel(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  if (options.id === undefined) { err('--id is required'); process.exit(1); }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  const hash = await walletClient.writeContract({
    address: proto.market, abi: MARKET_ABI, functionName: 'cancelListing',
    args: [BigInt(options.id)],
  });
  ok(`tx submitted: ${hash}`);
  inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
  await pubClient.waitForTransactionReceipt({ hash });
  ok(`Listing #${options.id} cancelled`);
  console.log('');
}
