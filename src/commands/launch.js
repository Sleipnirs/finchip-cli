import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig, getPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient, parseEther } from '../client.js';
import { ADDRESSES, FACTORY_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtChain, c } from '../utils.js';

/**
 * Launch a chip from a manifest JSON file.
 *
 * Manifest format (chip.json):
 * {
 *   "name":            "My Skill",
 *   "slug":            "my-skill_finchip",
 *   "metadataURI":     "ipfs://Qm...",
 *   "contentHash":     "0x...",          // bytes32 sha256 of content
 *   "sourceUrl":       "ipfs://Qm...",   // encrypted IPFS CID
 *   "category":        "Finance",
 *   "licenseType":     "MIT",
 *   "feeModel":        0,                // 0=ONETIME
 *   "licensePrice":    "0.01",           // in ETH/BNB (string)
 *   "maxSupply":       0,                // 0 = unlimited
 *   "royaltyBPS":      250,              // 2.5%
 *   "imageURI":        "ipfs://Qm...",
 *   "usageLimit":      0                 // 0 = unlimited
 * }
 */
export async function cmdLaunch(pathArg, options) {
  const cfg     = loadConfig();
  const chainId = parseInt(options.chain || cfg.chain || 56);

  // Resolve manifest path
  const manifestPath = pathArg
    ? resolve(pathArg.endsWith('.json') ? pathArg : `${pathArg}/chip.json`)
    : resolve('./chip.json');

  if (!existsSync(manifestPath)) {
    err(`Manifest not found: ${manifestPath}`);
    inf('Create a chip.json file with your chip metadata, or pass a directory containing chip.json');
    inf('');
    inf('Minimal chip.json:');
    inf(JSON.stringify({
      name: 'My Skill',
      slug: 'my-skill_finchip',
      metadataURI: 'ipfs://Qm...',
      contentHash: '0x' + '0'.repeat(64),
      sourceUrl: 'ipfs://Qm...',
      category: 'General',
      licenseType: 'MIT',
      feeModel: 0,
      licensePrice: '0.01',
      maxSupply: 0,
      royaltyBPS: 250,
      imageURI: '',
      usageLimit: 0,
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

  // Validate required fields
  const required = ['name', 'slug', 'metadataURI', 'contentHash', 'sourceUrl', 'licensePrice'];
  for (const f of required) {
    if (!manifest[f]) { err(`Missing required field: ${f}`); process.exit(1); }
  }

  const factoryAddr = ADDRESSES.factory[chainId];
  if (!factoryAddr) { err(`Unsupported chain: ${chainId}`); process.exit(1); }

  const privateKey = getPrivateKey(cfg);
  const { client: walletClient, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chainId, cfg.rpc);

  hd('FinChip CLI — launch');
  sep();
  inf(`manifest: ${manifestPath}`);
  inf(`name:     ${manifest.name}`);
  inf(`slug:     ${manifest.slug}`);
  inf(`price:    ${manifest.licensePrice} ${chainId === 56 ? 'BNB' : 'ETH'}`);
  inf(`category: ${manifest.category || 'General'}`);
  inf(`chain:    ${fmtChain(chainId)}`);
  inf(`creator:  ${account.address}`);
  console.log('');
  inf('Sending deployChip transaction…');

  try {
    const priceWei = parseEther(String(manifest.licensePrice));
    const hash = await walletClient.writeContract({
      address: factoryAddr,
      abi:     FACTORY_ABI,
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

    ok(`tx submitted: ${hash}`);
    inf('Waiting for confirmation…');

    const receipt = await pubClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      err('Transaction reverted');
      process.exit(1);
    }

    // Parse ChipDeployedV2 event to get chip address
    const deployLog = receipt.logs.find(l =>
      l.topics[0] === '0x' + 'ChipDeployedV2'.split('').map(c => c.charCodeAt(0).toString(16)).join('')
    );

    ok(`Chip deployed · block ${receipt.blockNumber}`);
    if (receipt.logs[0]?.address) {
      ok(`chip contract: ${receipt.logs[0].address}`);
    }
    inf(`slug: ${manifest.slug}`);
    inf(`Run: finchip market list  to see your chip in the market`);

  } catch (e) {
    err(`Launch failed: ${e.shortMessage || e.message?.split('\n')[0] || e}`);
    if (e.message?.includes('slug')) inf('Slug may already be taken. Try a different slug.');
    process.exit(1);
  }
  console.log('');
}
