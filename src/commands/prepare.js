// finchip prepare — full pipeline: encrypt → IPFS → deploy → setLitData → register-chip
//
// One command does:
//   1. Read + hash file
//   2. Upload metadata JSON to IPFS
//   3. Deploy chip on-chain
//   4. Encrypt file (3 modes: finchip / lit / agent)
//   5. Upload encrypted content to IPFS
//   6. setLitData on the chip
//   7. Register chip in FinChip database

import { readFileSync, existsSync } from 'fs';
import { createHash, randomBytes, createCipheriv } from 'crypto';
import { resolve, basename } from 'path';
import { decodeEventLog, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { loadConfig, getPrivateKey, getPinataJwt } from '../config.js';
import { resolveProtocol } from '../discovery.js';
import { getPublicClient, getWalletClient, parseEther } from '../client.js';
import { FACTORY_ABI, CHIP_ABI, CHIP_721_ABI } from '../protocol.js';
import { apiGetKey, apiLitEncrypt, apiRegisterChip, DEFAULT_BASE } from '../a2a-client.js';
import { resolveChain } from '../chains.js';
import { ok, err, inf, hd, sep, fmtChain, fmtWei, fmtTxLink, c } from '../utils.js';

// ── AES-256-GCM encryption ──────────────────────────────────────────────────
function aesEncrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex.replace('0x', '').slice(0, 64), 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

// ── Sign message with wallet (for API auth) ──────────────────────────────────
async function signMessage(message, privateKey) {
  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message });
}

// ── Pinata IPFS ─────────────────────────────────────────────────────────────
async function pinToPinata(filename, content, jwt) {
  const formData = new FormData();
  formData.append('file', new Blob([content]), filename);
  formData.append('pinataMetadata', JSON.stringify({ name: filename }));
  formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: formData,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${await res.text()}`);
  return `ipfs://${(await res.json()).IpfsHash}`;
}

async function pinJsonToPinata(name, obj, jwt) {
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinataContent: obj, pinataMetadata: { name } }),
  });
  if (!res.ok) throw new Error(`Pinata JSON ${res.status}: ${await res.text()}`);
  return `ipfs://${(await res.json()).IpfsHash}`;
}

// ── Encrypt modes ────────────────────────────────────────────────────────────
async function encryptFinchip({ fileContent, chipAddr, chainId, walletAddress, privateKey }) {
  inf('Requesting Master Key from FinChip API…');
  const message   = `FinChip encrypt: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
  const signature = await signMessage(message, privateKey);

  const { serverKey } = await apiGetKey({
    chipAddress: chipAddr, chainId, walletAddress, signature, message,
  });
  ok(`serverKey received (Master Key scheme)`);

  const encrypted = aesEncrypt(fileContent, serverKey);
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  return {
    encrypted,
    ciphertext: 'master-key-v1',
    dataToEncryptHash,
  };
}

async function encryptLit({ fileContent, chipAddr, chainId, walletAddress, privateKey }) {
  inf('Encrypting with FinChip Lit PKP (Chipotle)…');
  const message   = `FinChip lit-encrypt: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
  const signature = await signMessage(message, privateKey);

  const aesKey    = randomBytes(32);
  const encrypted = aesEncrypt(fileContent, aesKey.toString('hex'));
  const aesKeyBase64 = aesKey.toString('base64');
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  const { ciphertext } = await apiLitEncrypt({
    chipAddress: chipAddr, chainId, walletAddress, signature, message, aesKeyBase64,
  });
  ok(`Lit PKP ciphertext received`);

  return { encrypted, ciphertext, dataToEncryptHash };
}

async function encryptAgent({ fileContent }) {
  inf("Encrypting with Agent's own AES-256 key…");
  const aesKey    = randomBytes(32);
  const encrypted = aesEncrypt(fileContent, aesKey.toString('hex'));
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  const ciphertext = `agent-key-v1:${aesKey.toString('base64')}`;

  inf(`${c.yellow}⚠ Agent mode: you must run a persistent decrypt service.${c.reset}`);
  inf(`   Holders prove balanceOf to your endpoint to retrieve the key.`);
  inf(`   Store your AES key securely — it is embedded in the on-chain ciphertext.`);

  return { encrypted, ciphertext, dataToEncryptHash };
}

// ── Deploy chip via Factory ─────────────────────────────────────────────────
async function deployChipOnChain({ walletClient, pubClient, factoryAddr, isErc721, args, account }) {
  const fn = isErc721 ? 'deployChip721' : 'deployChip';
  const hash = await walletClient.writeContract({
    address: factoryAddr, abi: FACTORY_ABI, functionName: fn, args,
  });
  ok(`deploy tx: ${hash}`);
  inf('Waiting for confirmation…');
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Deploy reverted');

  // Decode chip address from event
  const eventName = isErc721 ? 'Chip721DeployedV2' : 'ChipDeployedV2';
  const topicHash = keccak256(toBytes(`${eventName}(address,address,string)`));
  let chipAddr = null;
  for (const log of receipt.logs) {
    if (log.topics[0] !== topicHash) continue;
    try {
      const decoded = decodeEventLog({
        abi: FACTORY_ABI, eventName, data: log.data, topics: log.topics,
      });
      chipAddr = decoded.args.chipContract;
      break;
    } catch { /* try next */ }
  }
  // Fallback to chipsOf
  if (!chipAddr) {
    const chips = await pubClient.readContract({
      address: factoryAddr, abi: FACTORY_ABI,
      functionName: isErc721 ? 'chips721Of' : 'chipsOf',
      args: [account.address],
    });
    chipAddr = chips[chips.length - 1];
  }
  return { chipAddr, blockNumber: receipt.blockNumber, txHash: hash };
}

// ── setLitData ──────────────────────────────────────────────────────────────
async function storeLitData({ walletClient, pubClient, chipAddr, abi, ciphertext, dataToEncryptHash, chainName }) {
  const hash = await walletClient.writeContract({
    address: chipAddr, abi, functionName: 'setLitData',
    args: [ciphertext, dataToEncryptHash, chainName],
  });
  ok(`setLitData tx: ${hash}`);
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('setLitData reverted');
  ok(`Lit data stored on-chain · block ${receipt.blockNumber}`);
}

// ── Main command ────────────────────────────────────────────────────────────
export async function cmdPrepare(filepath, options) {
  const cfg          = loadConfig();
  const chain        = resolveChain(options.chain || cfg.chain);
  const encryptMode  = (options.encrypt || 'finchip').toLowerCase();
  const isErc721     = !!options.fork || options.standard === 'ERC721' || options.standard === '721';

  // Validate file
  const absPath = resolve(filepath);
  if (!existsSync(absPath)) { err(`File not found: ${absPath}`); process.exit(1); }

  const slug = options.slug;
  if (!slug)                            { err('--slug is required'); process.exit(1); }
  if (!slug.endsWith('_finchip'))       { err('Slug must end with _finchip'); process.exit(1); }

  const name       = options.name || basename(absPath).replace(/\.[^.]+$/, '').replace(/-/g, ' ');
  const privateKey = getPrivateKey(cfg);
  const pinataJwt  = getPinataJwt(cfg);
  if (!pinataJwt) {
    err('PINATA_JWT not set.');
    inf('Get one at https://app.pinata.cloud/keys');
    inf('Set: export PINATA_JWT=your_jwt_token');
    process.exit(1);
  }

  const proto = await resolveProtocol(chain.id, cfg.rpc).catch(e => {
    err(`Discovery failed: ${e.shortMessage || e.message}`); process.exit(1);
  });
  if (proto.factoryPaused) {
    err('Factory is paused on this chain.'); process.exit(1);
  }

  const { client: walletClient, account } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chain.id, cfg.rpc);

  hd(`FinChip CLI — prepare (${isErc721 ? 'ERC-721 fork' : 'ERC-1155 license'})`);
  sep();
  inf(`file:     ${absPath}`);
  inf(`name:     ${name}`);
  inf(`slug:     ${slug}`);
  inf(`price:    ${options.price || '0.01'} ${chain.symbol}`);
  inf(`chain:    ${fmtChain(chain.id)}`);
  inf(`encrypt:  ${encryptMode}`);
  inf(`creator:  ${account.address}`);
  console.log('');

  // ── 1. Read + hash ────────────────────────────────────────────────────────
  inf('Step 1/6 · Reading file + computing content hash…');
  const fileContent = readFileSync(absPath);
  const contentHash = '0x' + createHash('sha256').update(fileContent).digest('hex');
  ok(`contentHash: ${contentHash.slice(0, 18)}…`);

  // ── 2. Metadata + deploy ─────────────────────────────────────────────────
  inf('Step 2/6 · Uploading metadata to IPFS + deploying chip on-chain…');
  const metadataObj = {
    name,
    description: options.description || `${name} — a FinChip skill token`,
    category:    options.category    || 'General',
    version:     '1.0.0',
    standard:    isErc721 ? 'ERC721' : 'ERC1155',
    created:     new Date().toISOString(),
  };
  const metadataURI = await pinJsonToPinata(`${slug}-metadata`, metadataObj, pinataJwt);
  ok(`metadataURI: ${metadataURI}`);

  const priceWei = parseEther(String(options.price || '0.01'));

  // Build args based on standard
  const deployArgs = isErc721 ? [
    name, slug, metadataURI, contentHash,
    'ipfs://placeholder',
    options.category    || 'General',
    options.licenseType || 'MIT',
    priceWei,
    BigInt(options.maxForks ?? 0),
    parseInt(options.royaltyBps || '250'),
    options.imageUri || '',
  ] : [
    name, slug, metadataURI, contentHash,
    'ipfs://placeholder',
    options.category    || 'General',
    options.licenseType || 'MIT',
    0, priceWei,
    BigInt(options.maxSupply ?? 0),
    parseInt(options.royaltyBps || '250'),
    options.imageUri || '',
    BigInt(0),
  ];

  const { chipAddr, blockNumber } = await deployChipOnChain({
    walletClient, pubClient,
    factoryAddr: proto.factory,
    isErc721, args: deployArgs, account,
  });
  ok(`chip deployed: ${chipAddr} · block ${blockNumber}`);

  // ── 3. Encrypt ────────────────────────────────────────────────────────────
  inf(`Step 3/6 · Encrypting file (mode: ${encryptMode})…`);
  let encResult;
  if (encryptMode === 'finchip') {
    encResult = await encryptFinchip({
      fileContent, chipAddr, chainId: chain.id,
      walletAddress: account.address, privateKey,
    });
  } else if (encryptMode === 'lit') {
    encResult = await encryptLit({
      fileContent, chipAddr, chainId: chain.id,
      walletAddress: account.address, privateKey,
    });
  } else if (encryptMode === 'agent') {
    encResult = await encryptAgent({ fileContent });
  } else {
    err(`Unknown --encrypt mode: ${encryptMode}. Use: finchip | lit | agent`);
    process.exit(1);
  }
  const { encrypted, ciphertext, dataToEncryptHash } = encResult;

  // ── 4. Upload encrypted content ──────────────────────────────────────────
  inf('Step 4/6 · Uploading encrypted content to IPFS…');
  const sourceUrl = await pinToPinata(`${slug}-encrypted`, encrypted, pinataJwt);
  ok(`sourceUrl: ${sourceUrl}`);

  // ── 5. setLitData ────────────────────────────────────────────────────────
  inf('Step 5/6 · Writing encryption metadata on-chain (setLitData)…');
  await storeLitData({
    walletClient, pubClient, chipAddr,
    abi: isErc721 ? CHIP_721_ABI : CHIP_ABI,
    ciphertext, dataToEncryptHash, chainName: chain.key,
  });

  // ── 6. Register in FinChip DB ────────────────────────────────────────────
  inf('Step 6/6 · Registering chip in FinChip database…');
  try {
    const message   = `FinChip register-chip: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
    const signature = await signMessage(message, privateKey);
    const reg = await apiRegisterChip({
      contractAddr:   chipAddr,
      chainId:        chain.id,
      walletAddress:  account.address,
      signature,
      message,
      txHash:         null,
      blockNumber:    null,
      name,
      slug,
      category:       options.category    || 'General',
      description:    options.description || '',
      version:        '1.0.0',
      sourceUrl,
      metadataUri:    metadataURI,
      priceWei:       priceWei.toString(),
      royaltyBps:     parseInt(options.royaltyBps || '250'),
      maxSupply:      isErc721 ? parseInt(options.maxForks ?? 0) : parseInt(options.maxSupply ?? 0),
      feeModel:       0,
      license:        options.licenseType || 'MIT',
      tokenType:      isErc721 ? 'ERC721' : 'ERC1155',
      encryptMode,
      sourceFilename: basename(absPath),
    });
    if (reg.ok) {
      ok(`Registered in database · market_eligible: ${reg.body.marketEligible}`);
      if (!reg.body.marketEligible) {
        inf(`encrypt mode "${encryptMode}" — chip not listed on FinChip Market`);
      }
    } else {
      inf(`Database registration skipped (${reg.status}): ${String(reg.body).slice(0, 100)}`);
    }
  } catch (e) {
    inf(`Database registration skipped: ${e.message?.split('\n')[0]}`);
  }

  // ── Done ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  ok(`Chip live: ${slug}`);
  inf(`contract:  ${chipAddr}`);
  inf(`sourceUrl: ${sourceUrl}`);
  inf(`encrypt:   ${encryptMode}`);
  inf(`price:     ${fmtWei(priceWei, chain.id)}`);
  inf(`chain:     ${fmtChain(chain.id)}`);
  console.log('');
  if (encryptMode === 'finchip') {
    inf(`Holders decrypt via: POST ${DEFAULT_BASE}/api/get-key`);
  } else if (encryptMode === 'lit') {
    inf(`Holders decrypt via: POST ${DEFAULT_BASE}/api/lit-decrypt`);
  } else {
    inf('Holders decrypt via: your own Agent decrypt service');
  }
  console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log('');
}
