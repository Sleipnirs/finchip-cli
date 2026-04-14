/**
 * finchip prepare <filepath> [options]
 *
 * Full pipeline — encrypt + IPFS + deploy + setLitData — in one command.
 *
 * --encrypt options:
 *   finchip (default) — uses FinChip Master Key via /api/get-key
 *                       fully autonomous, just HTTP + wallet signature
 *   lit               — uses FinChip Lit PKP via /api/lit-encrypt
 *                       same HTTP approach, Chipotle handles PKP
 *   agent             — Agent's own AES key, Agent runs its own decrypt service
 *
 * Required env vars:
 *   FINCHIP_PRIVATE_KEY  — Agent wallet private key (0x...)
 *   PINATA_JWT           — Pinata API JWT for IPFS pinning
 *
 * Optional env vars:
 *   FINCHIP_API_URL      — override API base (default: https://finchip.ai)
 */

import { readFileSync, existsSync } from 'fs';
import { createHash, randomBytes, createCipheriv } from 'crypto';
import { resolve, basename } from 'path';
import { loadConfig, getPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient, parseEther } from '../client.js';
import { ADDRESSES, FACTORY_ABI, CHIP_ABI } from '../contracts.js';
import { ok, err, inf, hd, sep, fmtChain, fmtWei, c } from '../utils.js';

const API_BASE = process.env.FINCHIP_API_URL || 'https://finchip.ai';

// ── AES-256-GCM encrypt ───────────────────────────────────────────────────────
function aesEncrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex.replace('0x','').slice(0, 64), 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

// ── Sign a message with Agent's private key (for FinChip API auth) ────────────
async function signMessage(message, privateKey) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message });
}

// ── Pinata IPFS upload ────────────────────────────────────────────────────────
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

// ── Deploy chip on-chain ──────────────────────────────────────────────────────
async function deployChip({ walletClient, pubClient, factoryAddr, args }) {
  const hash = await walletClient.writeContract({
    address: factoryAddr, abi: FACTORY_ABI, functionName: 'deployChip', args,
  });
  ok(`deploy tx: ${hash}`);
  inf('Waiting for confirmation…');
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Deploy reverted');
  // chip address from first log
  let chipAddr = receipt.logs[0]?.address;
  if (!chipAddr) {
    const chips = await pubClient.readContract({
      address: factoryAddr, abi: FACTORY_ABI,
      functionName: 'chipsOf', args: [walletClient.account.address],
    });
    chipAddr = chips[chips.length - 1];
  }
  return { chipAddr, blockNumber: receipt.blockNumber };
}

// ── setLitData on-chain ───────────────────────────────────────────────────────
async function storeLitData({ walletClient, pubClient, chipAddr, ciphertext, dataToEncryptHash, chainName }) {
  const hash = await walletClient.writeContract({
    address: chipAddr, abi: CHIP_ABI, functionName: 'setLitData',
    args: [ciphertext, dataToEncryptHash, chainName],
  });
  ok(`setLitData tx: ${hash}`);
  const receipt = await pubClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('setLitData reverted');
  ok(`Lit data stored on-chain · block ${receipt.blockNumber}`);
}

// ── Encrypt mode: finchip (Master Key via /api/get-key) ───────────────────────
async function encryptFinchip({ fileContent, chipAddr, chainId, walletAddress, privateKey }) {
  inf('Requesting Master Key from FinChip API…');
  const message   = `FinChip encrypt: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
  const signature = await signMessage(message, privateKey);

  const res = await fetch(`${API_BASE}/api/get-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chipAddress: chipAddr, chainId, walletAddress, signature, message }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`get-key ${res.status}: ${txt}`);
  }
  const { serverKey } = await res.json();
  ok(`serverKey received (Master Key scheme)`);

  // Encrypt file with serverKey as AES key
  const encrypted = aesEncrypt(fileContent, serverKey);
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  // ciphertext stored on-chain = marker indicating Master Key scheme
  return {
    encrypted,
    ciphertext: 'master-key-v1',
    dataToEncryptHash,
  };
}

// ── Encrypt mode: lit (FinChip Lit PKP via /api/lit-encrypt) ─────────────────
async function encryptLit({ fileContent, chipAddr, chainId, walletAddress, privateKey }) {
  inf('Encrypting with FinChip Lit PKP (Chipotle)…');
  const message   = `FinChip lit-encrypt: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
  const signature = await signMessage(message, privateKey);

  // Generate random AES key, encrypt file locally
  const aesKey    = randomBytes(32);
  const encrypted = aesEncrypt(fileContent, aesKey.toString('hex'));
  const aesKeyBase64 = aesKey.toString('base64');
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  // FinChip backend encrypts the AES key with PKP
  const res = await fetch(`${API_BASE}/api/lit-encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chipAddress: chipAddr, chainId, walletAddress, signature, message, aesKeyBase64,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`lit-encrypt ${res.status}: ${txt}`);
  }
  const { ciphertext } = await res.json();
  ok(`Lit PKP ciphertext received`);

  return { encrypted, ciphertext, dataToEncryptHash };
}

// ── Encrypt mode: agent (Agent's own AES key, self-hosted decrypt service) ────
async function encryptAgent({ fileContent }) {
  inf('Encrypting with Agent\'s own AES-256 key…');
  const aesKey    = randomBytes(32);
  const encrypted = aesEncrypt(fileContent, aesKey.toString('hex'));
  const dataToEncryptHash = '0x' + createHash('sha256').update(encrypted).digest('hex');

  // Agent stores its own public key / endpoint as ciphertext marker
  // Format: "agent-key-v1:<base64_aes_key>" — Agent must protect this key
  // and run a decrypt service that verifies balanceOf before returning it
  const ciphertext = `agent-key-v1:${aesKey.toString('base64')}`;

  inf(`${c.yellow}⚠  Agent mode: you must run a persistent decrypt service.${c.reset}`);
  inf(`   Holders prove balanceOf to your service endpoint to get the key.`);
  inf(`   Store your AES key securely — it is embedded in the on-chain ciphertext.`);

  return { encrypted, ciphertext, dataToEncryptHash };
}

// ── Main command ──────────────────────────────────────────────────────────────
export async function cmdPrepare(filepath, options) {
  const cfg        = loadConfig();
  const chainId    = parseInt(options.chain || cfg.chain || 56);
  const symbol     = chainId === 56 ? 'BNB' : 'ETH';
  const chainName  = chainId === 56 ? 'bsc' : 'base';
  const encryptMode = (options.encrypt || 'finchip').toLowerCase();

  // Validate file
  const absPath = resolve(filepath);
  if (!existsSync(absPath)) { err(`File not found: ${absPath}`); process.exit(1); }

  const slug = options.slug;
  if (!slug) { err('--slug is required (must end with _finchip)'); process.exit(1); }
  if (!slug.endsWith('_finchip')) { err('Slug must end with _finchip'); process.exit(1); }

  const name       = options.name || basename(absPath).replace(/\.[^.]+$/, '').replace(/-/g, ' ');
  const privateKey = getPrivateKey(cfg);
  const pinataJwt  = process.env.PINATA_JWT || cfg.pinataJwt;
  if (!pinataJwt) {
    err('PINATA_JWT not set.');
    inf('Get one at https://app.pinata.cloud/keys');
    inf('Set: export PINATA_JWT=your_jwt_token');
    process.exit(1);
  }

  hd('FinChip CLI — prepare');
  sep();
  inf(`file:    ${absPath}`);
  inf(`name:    ${name}`);
  inf(`slug:    ${slug}`);
  inf(`price:   ${options.price || '0.01'} ${symbol}`);
  inf(`chain:   ${fmtChain(chainId)}`);
  inf(`encrypt: ${encryptMode}`);
  console.log('');

  // ── Step 1: Read + hash ────────────────────────────────────────────────────
  inf('Step 1/6 · Reading file + computing content hash…');
  const fileContent = readFileSync(absPath);
  const contentHash = '0x' + createHash('sha256').update(fileContent).digest('hex');
  ok(`contentHash: ${contentHash.slice(0,18)}…`);

  // ── Step 2: Deploy chip ────────────────────────────────────────────────────
  inf('Step 2/6 · Uploading metadata + deploying chip on-chain…');
  const factoryAddr = ADDRESSES.factory[chainId];
  const { client: walletClient, account } = getWalletClient(chainId, privateKey, cfg.rpc);
  const pubClient = getPublicClient(chainId, cfg.rpc);

  inf('  Uploading metadata JSON to IPFS…');
  const metadataObj = {
    name, description: options.description || `${name} — a FinChip skill token`,
    category: options.category || 'General', version: '1.0.0',
    created: new Date().toISOString(),
  };
  const metadataURI = await pinJsonToPinata(`${slug}-metadata`, metadataObj, pinataJwt);
  ok(`metadataURI: ${metadataURI}`);

  // Placeholder sourceUrl — will update after we have encrypted content
  const priceWei = parseEther(String(options.price || '0.01'));

  const { chipAddr, blockNumber } = await deployChip({
    walletClient, pubClient, factoryAddr,
    args: [
      name, slug, metadataURI, contentHash,
      'ipfs://placeholder', // sourceUrl — updated below
      options.category || 'General',
      options.licenseType || 'MIT',
      0, priceWei,
      BigInt(options.maxSupply || 0),
      parseInt(options.royaltyBPS || '250'),
      options.imageUri || '',
      BigInt(0),
    ],
  });
  ok(`chip deployed: ${chipAddr} · block ${blockNumber}`);

  // ── Step 3: Encrypt file ───────────────────────────────────────────────────
  inf(`Step 3/6 · Encrypting file (mode: ${encryptMode})…`);
  let encrypted, ciphertext, dataToEncryptHash;

  if (encryptMode === 'finchip') {
    ({ encrypted, ciphertext, dataToEncryptHash } = await encryptFinchip({
      fileContent, chipAddr, chainId,
      walletAddress: account.address, privateKey,
    }));
  } else if (encryptMode === 'lit') {
    ({ encrypted, ciphertext, dataToEncryptHash } = await encryptLit({
      fileContent, chipAddr, chainId,
      walletAddress: account.address, privateKey,
    }));
  } else if (encryptMode === 'agent') {
    ({ encrypted, ciphertext, dataToEncryptHash } = await encryptAgent({ fileContent }));
  } else {
    err(`Unknown --encrypt mode: ${encryptMode}. Use: finchip | lit | agent`);
    process.exit(1);
  }

  // ── Step 4: Upload encrypted content to IPFS ──────────────────────────────
  inf('Step 4/6 · Uploading encrypted content to IPFS…');
  const sourceUrl = await pinToPinata(`${slug}-encrypted`, encrypted, pinataJwt);
  ok(`sourceUrl: ${sourceUrl}`);

  // ── Step 5: setLitData on-chain ────────────────────────────────────────────
  inf('Step 5/6 · Writing encryption metadata on-chain (setLitData)…');
  await storeLitData({ walletClient, pubClient, chipAddr, ciphertext, dataToEncryptHash, chainName });

  // ── Step 6/6: Register in FinChip database ──────────────────────────────────
  inf('Step 6/6 · Registering chip in FinChip database…');
  try {
    const message   = `FinChip register-chip: ${chipAddr.toLowerCase()} @ ${Date.now()}`;
    const signature = await signMessage(message, privateKey);
    const regRes = await fetch(`${API_BASE}/api/register-chip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractAddr:  chipAddr,
        chainId,
        walletAddress: account.address,
        signature,
        message,
        txHash:        null,
        blockNumber:   null,
        name,
        slug,
        category:      options.category || 'General',
        description:   options.description || '',
        version:       '1.0.0',
        sourceUrl,
        metadataUri:   metadataURI,
        priceWei:      priceWei.toString(),
        royaltyBps:    parseInt(options.royaltyBps || '250'),
        maxSupply:     parseInt(options.maxSupply || '0'),
        feeModel:      0,
        license:       options.licenseType || 'MIT',
        tokenType:     'ERC1155',
        encryptMode:   encryptMode,
        sourceFilename: require('path').basename(absPath),
      }),
    });
    if (regRes.ok) {
      const regData = await regRes.json();
      ok(`Registered in database · market_eligible: ${regData.marketEligible}`);
      if (!regData.marketEligible) {
        inf(`encrypt mode "${encryptMode}" — chip not listed on FinChip Market`);
      }
    } else {
      const txt = await regRes.text();
      inf(`Database registration skipped (${regRes.status}): ${txt.slice(0, 100)}`);
    }
  } catch (e) {
    inf(`Database registration skipped: ${e.message?.split('\n')[0]}`);
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  ok(`Chip live: ${slug}`);
  inf(`contract:  ${chipAddr}`);
  inf(`sourceUrl: ${sourceUrl}`);
  inf(`encrypt:   ${encryptMode}`);
  inf(`price:     ${fmtWei(priceWei, symbol)}`);
  inf(`chain:     ${fmtChain(chainId)}`);
  console.log('');
  if (encryptMode === 'finchip') {
    inf('Holders decrypt via: POST https://finchip.ai/api/get-key');
  } else if (encryptMode === 'lit') {
    inf('Holders decrypt via: POST https://finchip.ai/api/lit-decrypt');
  } else {
    inf('Holders decrypt via: your own Agent decrypt service');
  }
  console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log('');
}
