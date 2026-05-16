// finchip acquire — purchase a license (ERC-1155) or fork (ERC-721)
// Auto-detects standard via ERC-165 supportsInterface; --fork forces 721.
import { loadConfig, getPrivateKey } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { CHIP_REGISTRY_ABI, CHIP_ABI, CHIP_721_ABI, IFACE_ID } from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtAddr, fmtWei, fmtChain, fmtTxLink } from '../utils.js';

export async function cmdAcquire(options) {
  const cfg    = loadConfig();
  const chain  = resolveChain(options.chain || cfg.chain);
  const slug   = options.slug;
  const forceFork = !!options.fork;

  if (!slug) {
    err('--slug is required. Example: finchip acquire --slug audit-pro_finchip');
    process.exit(1);
  }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });

  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  hd(`FinChip CLI — acquire`);
  sep();
  inf(`slug:   ${slug}`);
  inf(`wallet: ${account.address}`);
  inf(`chain:  ${fmtChain(chain.id)}`);

  // Resolve chip
  let chipAddr;
  try {
    chipAddr = await pubClient.readContract({
      address:      proto.chipRegistry,
      abi:          CHIP_REGISTRY_ABI,
      functionName: 'resolve',
      args:         [slug],
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

  // Detect standard (unless --fork forces 721)
  let isFork = forceFork;
  if (!forceFork) {
    try {
      const is721 = await pubClient.readContract({
        address: chipAddr, abi: CHIP_ABI,
        functionName: 'supportsInterface', args: [IFACE_ID.ERC721],
      });
      isFork = !!is721;
    } catch { isFork = false; }
  }
  inf(`type:   ${isFork ? 'ERC-721 fork' : 'ERC-1155 license'}`);

  if (isFork) {
    await acquireFork({ pubClient, walletClient, chipAddr, account, chain, options });
  } else {
    await acquireLicense({ pubClient, walletClient, chipAddr, account, chain, options });
  }
}

async function acquireLicense({ pubClient, walletClient, chipAddr, account, chain, options }) {
  const [name, price, totalMinted, maxSupply] = await Promise.all([
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'name'         }).catch(() => '(unknown)'),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'licensePrice' }),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'totalMinted'  }).catch(() => 0n),
    pubClient.readContract({ address: chipAddr, abi: CHIP_ABI, functionName: 'maxSupply'    }).catch(() => 0n),
  ]);

  console.log('');
  inf(`name:   ${name}`);
  inf(`price:  ${fmtWei(price, chain.id)}`);
  inf(`minted: ${totalMinted}${maxSupply > 0n ? ` / ${maxSupply}` : ''}`);

  if (maxSupply > 0n && totalMinted >= maxSupply) {
    err('Chip is sold out.');
    process.exit(1);
  }

  // Check existing balance
  try {
    const balance = await pubClient.readContract({
      address: chipAddr, abi: CHIP_ABI, functionName: 'balanceOf',
      args:    [account.address, 1n],
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
  inf('Sending purchaseLicense…');
  try {
    const hash = await walletClient.writeContract({
      address: chipAddr, abi: CHIP_ABI, functionName: 'purchaseLicense',
      value:   BigInt(price),
    });
    ok(`tx submitted: ${hash}`);
    inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`License acquired · block ${receipt.blockNumber}`);
      inf(`cost: ${fmtWei(price, chain.id)}`);
      inf(`Run: finchip library  to see your skills`);
    } else {
      err('Transaction reverted'); process.exit(1);
    }
  } catch (e) {
    err(`Acquire failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    process.exit(1);
  }
  console.log('');
}

async function acquireFork({ pubClient, walletClient, chipAddr, account, chain, options }) {
  const [name, price, totalForked, maxForks] = await Promise.all([
    pubClient.readContract({ address: chipAddr, abi: CHIP_721_ABI, functionName: 'name'         }).catch(() => '(unknown)'),
    pubClient.readContract({ address: chipAddr, abi: CHIP_721_ABI, functionName: 'forkPrice'    }),
    pubClient.readContract({ address: chipAddr, abi: CHIP_721_ABI, functionName: 'totalForked'  }).catch(() => 0n),
    pubClient.readContract({ address: chipAddr, abi: CHIP_721_ABI, functionName: 'maxForks'     }).catch(() => 0n),
  ]);

  console.log('');
  inf(`name:        ${name}`);
  inf(`fork price:  ${fmtWei(price, chain.id)}`);
  inf(`forked:      ${totalForked}${maxForks > 0n ? ` / ${maxForks}` : ''}`);

  if (maxForks > 0n && totalForked >= maxForks) {
    err('Fork cap reached on this chip.');
    process.exit(1);
  }

  console.log('');
  inf('Sending purchaseFork…');
  try {
    const hash = await walletClient.writeContract({
      address: chipAddr, abi: CHIP_721_ABI, functionName: 'purchaseFork',
      value:   BigInt(price),
    });
    ok(`tx submitted: ${hash}`);
    inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      ok(`Fork acquired · block ${receipt.blockNumber}`);
      inf(`cost: ${fmtWei(price, chain.id)}`);
      inf(`Run: finchip library  to see your fork NFT`);
    } else {
      err('Transaction reverted'); process.exit(1);
    }
  } catch (e) {
    err(`Fork acquire failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    process.exit(1);
  }
  console.log('');
}
