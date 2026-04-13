import { loadConfig, getPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { ADDRESSES, CHIP_REGISTRY_ABI, CHIP_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtWei, fmtChain } from '../utils.js';

export async function cmdAcquire(options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);
  const slug    = options.slug;

  if (!slug) { err('--slug is required. Example: finchip acquire --slug audit-pro_finchip'); process.exit(1); }

  const regAddr = ADDRESSES.chipRegistry[chainId];
  if (!regAddr) { err(`Unsupported chain: ${chainId}`); process.exit(1); }

  const symbol     = chainId === 56 ? 'BNB' : 'ETH';
  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient  = getPublicClient(chainId, cfg.rpc);

  hd(`FinChip CLI — acquire`);
  sep();
  inf(`slug:   ${slug}`);
  inf(`wallet: ${account.address}`);
  inf(`chain:  ${fmtChain(chainId)}`);

  // Resolve chip address
  let chipAddr;
  try {
    chipAddr = await pubClient.readContract({
      address: regAddr, abi: CHIP_REGISTRY_ABI, functionName: 'resolve', args: [slug],
    });
  } catch (e) {
    err(`Failed to resolve slug "${slug}": ${e.shortMessage || e.message}`);
    process.exit(1);
  }

  if (!chipAddr || chipAddr === '0x0000000000000000000000000000000000000000') {
    err(`Slug not found: ${slug}`);
    process.exit(1);
  }
  inf(`chip:   ${chipAddr}`);

  // Read chip details
  const [name, price, totalMinted, maxSupply] = await Promise.all([
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'name' }).catch(() => slug),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'licensePrice' }),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'totalMinted' }).catch(() => 0n),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'maxSupply' }).catch(() => 0n),
  ]);

  console.log('');
  inf(`name:    ${name}`);
  inf(`price:   ${fmtWei(price, symbol)}`);
  inf(`minted:  ${totalMinted}${maxSupply > 0n ? ` / ${maxSupply}` : ''}`);

  if (maxSupply > 0n && totalMinted >= maxSupply) {
    err('Chip is sold out.');
    process.exit(1);
  }

  // Check if already holding license
  try {
    const balance = await pubClient.readContract({
      address: chipAddr, abi: CHIP_ABI, functionName: 'balanceOf',
      args: [account.address, 1n],
    });
    if (balance > 0n) {
      inf(`You already hold this license (balance: ${balance})`);
      if (!options.force) {
        inf('Use --force to acquire another copy.');
        process.exit(0);
      }
    }
  } catch { /* ignore */ }

  console.log('');
  inf(`Sending purchaseLicense…`);

  try {
    const hash = await walletClient.writeContract({
      address: chipAddr,
      abi:     CHIP_ABI,
      functionName: 'purchaseLicense',
      value: BigInt(price),
    });
    ok(`tx submitted: ${hash}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`License acquired · block ${receipt.blockNumber}`);
      inf(`chip: ${chipAddr}`);
      inf(`cost: ${fmtWei(price, symbol)}`);
      inf(`Run: finchip library  to see your chips`);
    } else {
      err('Transaction reverted');
      process.exit(1);
    }
  } catch (e) {
    err(`Acquire failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    process.exit(1);
  }
  console.log('');
}
