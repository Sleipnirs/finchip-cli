// finchip launch — deploy a chip from chip.json manifest
// Supports both ERC-1155 ("standard": "ERC1155") and ERC-721 ("standard": "ERC721").
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { decodeEventLog, keccak256, toBytes } from 'viem';
import { loadConfig, getPrivateKey } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient, getWalletClient, parseEther } from '../client.js';
import { FACTORY_ABI } from '../protocol.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtChain, fmtTxLink, c } from '../utils.js';

export async function cmdLaunch(pathArg, options) {
  const cfg   = loadConfig();
  const chain = resolveChain(options.chain || cfg.chain);

  // Resolve manifest path: file or directory (containing chip.json)
  const manifestPath = pathArg
    ? resolve(pathArg.endsWith('.json') ? pathArg : `${pathArg}/chip.json`)
    : resolve('./chip.json');

  if (!existsSync(manifestPath)) {
    err(`Manifest not found: ${manifestPath}`);
    inf('Create a chip.json file with your chip metadata.');
    inf('');
    inf('Minimal chip.json (ERC-1155 default):');
    console.log(JSON.stringify({
      name:         'My Skill',
      slug:         'my-skill_finchip',
      standard:     'ERC1155',  // or "ERC721" for fork chips
      metadataURI:  'ipfs://Qm...',
      contentHash:  '0x' + '0'.repeat(64),
      sourceUrl:    'ipfs://Qm...',
      category:     'General',
      licenseType:  'MIT',
      feeModel:     0,
      licensePrice: '0.01',     // or "forkPrice" for ERC-721
      maxSupply:    0,          // or "maxForks" for ERC-721
      royaltyBPS:   250,
      imageURI:     '',
      usageLimit:   0,
    }, null, 2));
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    err(`Failed to parse manifest: ${e.message}`);
    process.exit(1);
  }

  // Determine standard: --standard flag overrides manifest, default ERC1155
  const standard = (options.standard || manifest.standard || 'ERC1155').toUpperCase();
  if (!['ERC1155', 'ERC721', '1155', '721'].includes(standard)) {
    err(`Unknown --standard: "${standard}". Use ERC1155 or ERC721`);
    process.exit(1);
  }
  const isErc721 = standard === 'ERC721' || standard === '721';

  // Required fields
  const required = ['name', 'slug', 'metadataURI', 'contentHash', 'sourceUrl'];
  if (!isErc721) required.push('licensePrice');
  else required.push('forkPrice');
  for (const f of required) {
    if (!manifest[f]) { err(`Missing required field: ${f}`); process.exit(1); }
  }
  if (!manifest.slug.endsWith('_finchip')) {
    err(`Slug must end with _finchip (got: ${manifest.slug})`);
    process.exit(1);
  }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });

  if (proto.factoryPaused) {
    err('Factory is paused on this chain. Try again later or use a different chain.');
    process.exit(1);
  }

  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  hd(`FinChip CLI — launch (${isErc721 ? 'ERC-721 fork' : 'ERC-1155 license'})`);
  sep();
  inf(`manifest: ${manifestPath}`);
  inf(`name:     ${manifest.name}`);
  inf(`slug:     ${manifest.slug}`);
  inf(`price:    ${isErc721 ? manifest.forkPrice : manifest.licensePrice} ${chain.symbol}`);
  inf(`category: ${manifest.category || 'General'}`);
  inf(`chain:    ${fmtChain(chain.id)}`);
  inf(`creator:  ${account.address}`);
  inf(`factory:  ${proto.factory}`);
  console.log('');
  inf(`Sending ${isErc721 ? 'deployChip721' : 'deployChip'} transaction…`);

  try {
    let hash;
    if (isErc721) {
      const priceWei = parseEther(String(manifest.forkPrice));
      hash = await walletClient.writeContract({
        address:      proto.factory,
        abi:          FACTORY_ABI,
        functionName: 'deployChip721',
        args: [
          manifest.name,
          manifest.slug,
          manifest.metadataURI,
          manifest.contentHash,
          manifest.sourceUrl,
          manifest.category    || 'General',
          manifest.licenseType || 'MIT',
          priceWei,
          BigInt(manifest.maxForks   ?? 0),
          manifest.royaltyBPS  ?? 250,
          manifest.imageURI    || '',
        ],
      });
    } else {
      const priceWei = parseEther(String(manifest.licensePrice));
      hash = await walletClient.writeContract({
        address:      proto.factory,
        abi:          FACTORY_ABI,
        functionName: 'deployChip',
        args: [
          manifest.name,
          manifest.slug,
          manifest.metadataURI,
          manifest.contentHash,
          manifest.sourceUrl,
          manifest.category    || 'General',
          manifest.licenseType || 'MIT',
          manifest.feeModel    ?? 0,
          priceWei,
          BigInt(manifest.maxSupply  ?? 0),
          manifest.royaltyBPS  ?? 250,
          manifest.imageURI    || '',
          BigInt(manifest.usageLimit ?? 0),
        ],
      });
    }

    ok(`tx submitted: ${hash}`);
    inf(`explorer:     ${fmtTxLink(hash, chain.id)}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      err('Transaction reverted');
      process.exit(1);
    }

    // ── Parse event correctly using viem decodeEventLog ────────────────────
    const eventName = isErc721 ? 'Chip721DeployedV2' : 'ChipDeployedV2';
    const topicHash = keccak256(toBytes(`${eventName}(address,address,string)`));

    let chipAddr = null;
    for (const log of receipt.logs) {
      if (log.topics[0] !== topicHash) continue;
      try {
        const decoded = decodeEventLog({
          abi: FACTORY_ABI,
          eventName,
          data: log.data,
          topics: log.topics,
        });
        chipAddr = decoded.args.chipContract;
        break;
      } catch { /* try next */ }
    }

    // Fallback: query chipsOf / chips721Of
    if (!chipAddr) {
      try {
        const chips = await pubClient.readContract({
          address: proto.factory, abi: FACTORY_ABI,
          functionName: isErc721 ? 'chips721Of' : 'chipsOf',
          args: [account.address],
        });
        if (chips.length > 0) chipAddr = chips[chips.length - 1];
      } catch { /* give up */ }
    }

    ok(`Chip deployed · block ${receipt.blockNumber}`);
    if (chipAddr) ok(`chip contract: ${chipAddr}`);
    inf(`slug: ${manifest.slug}`);
    inf(`Run: finchip market list  to see your chip on the market`);
  } catch (e) {
    err(`Launch failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    if (e.message?.toLowerCase().includes('slug')) inf('Slug may already be taken. Try a different slug.');
    process.exit(1);
  }
  console.log('');
}
