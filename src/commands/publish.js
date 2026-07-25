import { readFileSync, statSync } from 'fs';
import { basename, extname, resolve } from 'path';
import { formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FinchipAuthClient } from '../auth-client.js';
import { loadConfig, resolveConfiguredPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { resolveProtocol } from '../discovery.js';
import { resolveChain } from '../chains.js';
import { FACTORY_ABI, CHIP_ABI } from '../protocol.js';
import { resolveDeployedChip } from '../publish-recovery.js';
import {
  BUNDLE_MAX_ENCRYPTED_BYTES,
  DEFAULT_CHIP_LOGO_URI,
  PRIMARY_MAX_ENCRYPTED_BYTES,
  buildContentManifest,
  buildSourceBundle,
  canonicalSlug,
  clearPublishState,
  collectPublishSource,
  encryptArtifact,
  loadPublishState,
  openRecoverySecret,
  savePublishState,
  sealRecoverySecret,
  sha256Hex,
  wrapFinchipV2ContentKey,
} from '../publish-utils.js';
import { CliError, emitFailure, emitResult, fmtAddr, fmtChain, hd, inf, ok, sep, wrn } from '../utils.js';

const API_TIMEOUT_MS = 60_000;
const TX_TIMEOUT_MS = 180_000;

class PublishError extends CliError {
  constructor(code, message, exitCode = 5, stage = null, details = {}) {
    super(code, message, exitCode, { stage, ...details });
  }
}

function fail(options, error) {
  const normalized = error?.code && Number.isInteger(error?.exitCode)
    ? error
    : new PublishError('PUBLISH_FAILED', error instanceof Error ? error.message : 'Publish failed.');
  emitFailure(options, normalized, { fields: { stage: null } });
}

function validateOptions(pathArg, options) {
  if (options.resume) return { slug: canonicalSlug(options.resume) };
  if (!pathArg) throw new PublishError('SOURCE_UNSAFE', 'A source file or Git directory is required.', 3, 'validation');
  const slug = canonicalSlug(options.slug);
  if (!options.name?.trim()) throw new PublishError('PUBLISH_INVALID', '--name is required.', 3, 'validation');
  if (!options.description?.trim()) throw new PublishError('PUBLISH_INVALID', '--description is required.', 3, 'validation');
  const fieldLimits = { name: 120, description: 5_000, category: 100, license: 100, version: 50 };
  for (const [field, limit] of Object.entries(fieldLimits)) {
    const value = String(options[field] || '').trim();
    if (!value || value.length > limit) {
      throw new PublishError('PUBLISH_INVALID', `${field} is required and must be ${limit} characters or fewer.`, 3, 'validation');
    }
  }
  if (options.price == null) throw new PublishError('PUBLISH_INVALID', '--price is required.', 3, 'validation');
  const priceText = String(options.price);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(priceText)) {
    throw new PublishError('PUBLISH_INVALID', 'Price must be a non-negative decimal with up to 18 places.', 3, 'validation');
  }
  let priceWei;
  try { priceWei = parseEther(priceText); }
  catch { throw new PublishError('PUBLISH_INVALID', 'Price must be a non-negative decimal with up to 18 places.', 3, 'validation'); }
  const royaltyBps = Number(options.royaltyBps ?? 500);
  const maxSupply = Number(options.maxSupply ?? 0);
  if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > 10_000) {
    throw new PublishError('PUBLISH_INVALID', 'royalty-bps must be an integer between 0 and 10000.', 3, 'validation');
  }
  if (!Number.isSafeInteger(maxSupply) || maxSupply < 0) {
    throw new PublishError('PUBLISH_INVALID', 'max-supply must be a non-negative safe integer.', 3, 'validation');
  }
  return { slug, priceWei, royaltyBps, maxSupply };
}

function resolveCoverOption(cover) {
  if (!cover) return { imageURI: DEFAULT_CHIP_LOGO_URI, path: null };
  if (cover.startsWith('ipfs://') && cover.length > 'ipfs://'.length) return { imageURI: cover, path: null };
  const coverPath = resolve(cover);
  let info;
  try { info = statSync(coverPath); }
  catch { throw new PublishError('SOURCE_UNSAFE', 'Cover file does not exist.', 3, 'validation'); }
  if (!info.isFile()) throw new PublishError('SOURCE_UNSAFE', 'Cover must be an image file or ipfs:// URI.', 3, 'validation');
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(coverPath).toLowerCase())) {
    throw new PublishError('SOURCE_UNSAFE', 'Cover must be a JPG, PNG, or WebP image.', 3, 'validation');
  }
  if (info.size <= 0 || info.size > 2 * 1024 * 1024) {
    throw new PublishError('SOURCE_TOO_LARGE', 'Cover image must be between 1 byte and 2 MB.', 3, 'validation');
  }
  return { imageURI: DEFAULT_CHIP_LOGO_URI, path: coverPath };
}

async function authenticatedContext(expectedWallet = null) {
  const client = new FinchipAuthClient();
  const session = await client.requireSession({
    walletRequired: true,
    missingMessage: 'Run `finchip login` before publishing.',
    expiredMessage: 'FinChip session is expired or has no active wallet session.',
    details: { stage: 'auth' },
  });
  const cfg = loadConfig();
  const privateKey = resolveConfiguredPrivateKey(cfg);
  if (!privateKey) {
    throw new PublishError('WALLET_MISMATCH', 'Set a valid FINCHIP_PRIVATE_KEY before publishing.', 3, 'auth');
  }
  const account = privateKeyToAccount(privateKey);
  const sessionWallet = session.wallet.walletAddr.toLowerCase();
  if (account.address.toLowerCase() !== sessionWallet || (expectedWallet && expectedWallet.toLowerCase() !== sessionWallet)) {
    throw new PublishError('WALLET_MISMATCH', 'Cookie wallet, recovery wallet, and private key must match.', 3, 'auth');
  }
  return { client, session, cfg, privateKey, account };
}

async function apiJson(client, path, options = {}) {
  return client.authenticatedJson(path, { timeoutMs: API_TIMEOUT_MS, ...options });
}

async function uploadFile(client, bytes, filename, purpose) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: purpose === 'cover' ? coverMime(filename) : 'application/octet-stream' }), filename);
  form.append('name', filename);
  form.append('purpose', purpose);
  const { response, payload } = await client.authenticatedJson('/api/skills/me/ipfs/upload', {
    method: 'POST', body: form, timeoutMs: API_TIMEOUT_MS,
  });
  if (!response.ok || !payload.uploadId || !String(payload.uri || '').startsWith('ipfs://')) {
    throw new PublishError('IPFS_UPLOAD_FAILED', payload.message || payload.error || `IPFS ${purpose} upload failed.`, 5, 'upload');
  }
  return payload;
}

function coverMime(filename) {
  const extension = extname(filename).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
}

async function uploadMetadata(client, input) {
  const { response, payload } = await apiJson(client, '/api/skills/me/ipfs/metadata', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok || !payload.uploadId || !String(payload.uri || '').startsWith('ipfs://')) {
    throw new PublishError('IPFS_UPLOAD_FAILED', payload.message || payload.error || 'Metadata upload failed.', 5, 'upload');
  }
  return payload;
}

async function updateUploads(client, path, body) {
  const { response, payload } = await apiJson(client, path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(payload.error || `${path} failed with ${response.status}`);
  return payload;
}

function recoveryContext(origin, slug, wallet) {
  return `${origin}:${slug}:${wallet.toLowerCase()}`;
}

async function finishPublish(state, context, contentKey) {
  const { client, privateKey, account, cfg } = context;
  const chain = resolveChain(state.chainId);
  const publicClient = getPublicClient(chain.id, cfg.rpc);
  const { client: walletClient } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const save = stage => {
    state.stage = stage;
    savePublishState(client.origin, state.slug, state);
  };

  if (state.stage === 'broadcast') {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: state.deployTxHash, timeout: TX_TIMEOUT_MS, pollingInterval: 4_000,
    });
    if (receipt.status !== 'success') throw new PublishError('DEPLOY_FAILED', 'Deploy transaction reverted.', 5, 'deploy');
    const deployment = resolveDeployedChip({
      receipt,
      factory: state.factoryAddr,
      creator: state.walletAddr,
      slug: state.slug,
    });
    for (const warning of deployment.warnings) wrn(warning);
    if (!deployment.contractAddr) {
      throw new PublishError(
        'DEPLOY_FAILED',
        'Could not uniquely resolve the deployed Chip address from the confirmed Factory receipt.',
        5,
        'deploy',
        {
          txHash: state.deployTxHash,
          slug: state.slug,
          candidateCount: deployment.candidateCount,
          resumable: true,
          resumeSlug: state.slug,
        },
      );
    }
    state.contractAddr = deployment.contractAddr;
    state.registerPayload = { ...state.registerBase, contract_addr: state.contractAddr };
    save('deployed');
  }

  if (state.stage === 'deployed') {
    await updateUploads(client, '/api/skills/me/ipfs/finalize', {
      uploadIds: state.uploadIds, status: 'attached', txHash: state.deployTxHash,
    });
    save('attached');
  }

  if (!['registered', 'key_set'].includes(state.stage)) {
    const { response, payload } = await apiJson(client, '/api/chips/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.registerPayload),
    });
    if (!response.ok || payload.ok !== true) {
      throw new PublishError('REGISTER_FAILED', payload.error || payload.code || 'Catalog registration failed.', 5, 'register');
    }
    state.skillId = payload.skill_id || state.skillId || null;
    save('registered');
  }

  if (state.stage !== 'key_set') {
    if (state.setLitTxHash) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: state.setLitTxHash, timeout: TX_TIMEOUT_MS, pollingInterval: 4_000,
        });
        if (receipt.status === 'success') {
          const visible = await publicClient.readContract({
            address: state.contractAddr, abi: CHIP_ABI, functionName: 'litDataSet',
          });
          if (!visible) {
            throw new PublishError('KEY_SETUP_FAILED', 'setLitData succeeded but is not visible on-chain yet.', 5, 'key_setup');
          }
          delete state.sealedContentKey;
          save('key_set');
        } else {
          delete state.setLitTxHash;
          savePublishState(client.origin, state.slug, state);
        }
      } catch (error) {
        const visible = await publicClient.readContract({
          address: state.contractAddr, abi: CHIP_ABI, functionName: 'litDataSet',
        }).catch(() => false);
        if (visible) {
          delete state.sealedContentKey;
          save('key_set');
        } else {
          throw error instanceof PublishError
            ? error
            : new PublishError(
                'KEY_SETUP_FAILED',
                `The saved setLitData transaction is still pending or unavailable. Resume again with the same slug. (${error instanceof Error ? error.message : 'RPC unavailable'})`,
                5,
                'key_setup',
              );
        }
      }
    }
  }

  if (state.stage !== 'key_set') {
    const message = `FinChip key request\nchip: ${state.contractAddr}\nwallet: ${account.address.toLowerCase()}\nnonce: ${Date.now()}`;
    const signature = await account.signMessage({ message });
    const { response, payload } = await apiJson(client, '/api/get-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chipAddress: state.contractAddr,
        chainId: state.chainId,
        walletAddress: account.address.toLowerCase(),
        signature,
        message,
      }),
    });
    if (!response.ok || !payload.serverKey) {
      throw new PublishError('KEY_SETUP_FAILED', payload.error || 'FinChip key service failed.', 5, 'key_setup');
    }
    const ciphertext = wrapFinchipV2ContentKey(payload.serverKey, contentKey);
    let setLitHash;
    try {
      setLitHash = await walletClient.writeContract({
        address: state.contractAddr,
        abi: CHIP_ABI,
        functionName: 'setLitData',
        args: [ciphertext, 'FINCHIP_V2', chain.key],
      });
      state.setLitTxHash = setLitHash;
      savePublishState(client.origin, state.slug, state);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: setLitHash, timeout: TX_TIMEOUT_MS, pollingInterval: 4_000 });
      if (receipt.status !== 'success') throw new Error('setLitData reverted.');
      const visible = await publicClient.readContract({ address: state.contractAddr, abi: CHIP_ABI, functionName: 'litDataSet' });
      if (!visible) throw new Error('setLitData is not visible on-chain.');
    } catch (error) {
      throw new PublishError('KEY_SETUP_FAILED', error instanceof Error ? error.message : 'setLitData failed.', 5, 'key_setup');
    }
    delete state.sealedContentKey;
    save('key_set');
  }

  const { response, payload } = await apiJson(client, '/api/chips/finalize-encrypted-source', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract_addr: state.contractAddr, chain_id: state.chainId, slug: state.slug }),
  });
  if (!response.ok || payload.ok !== true || payload.market_eligible !== true) {
    throw new PublishError('FINALIZE_FAILED', payload.error || payload.code || 'Market finalize failed.', 5, 'finalize');
  }
  await apiJson(client, '/api/points', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      wallet_addr: account.address.toLowerCase(), action: 'launch',
      chain_id: state.chainId, tx_hash: state.deployTxHash,
    }),
  }).catch(() => null);
  clearPublishState(client.origin, state.slug);
  return {
    ok: true, code: 'PUBLISH_COMPLETE', stage: 'market_ready', slug: state.slug,
    chainId: state.chainId, contractAddr: state.contractAddr, txHash: state.deployTxHash,
    setLitTxHash: state.setLitTxHash || null, skillId: state.skillId || null,
    sourceFiles: state.sourceFiles || [],
    excludedSensitiveFiles: state.excludedSensitiveFiles || [],
  };
}

async function resumePublish(slug, options) {
  const probe = new FinchipAuthClient();
  const state = loadPublishState(probe.origin, slug);
  if (!state) throw new PublishError('PUBLISH_RESUME_REQUIRED', `No saved publish state exists for ${slug}.`, 3, 'resume');
  const context = await authenticatedContext(state.walletAddr);
  if (state.origin !== context.client.origin || state.slug !== slug) {
    throw new PublishError('PUBLISH_RESUME_REQUIRED', 'Publish state does not match the current API origin or slug.', 3, 'resume');
  }
  if (options.chain && resolveChain(options.chain).id !== state.chainId) {
    throw new PublishError('PUBLISH_RESUME_REQUIRED', 'Publish state does not match the requested chain.', 3, 'resume');
  }
  const protocol = await resolveProtocol(state.chainId, context.cfg.rpc);
  if (!state.factoryAddr || protocol.factory.toLowerCase() !== state.factoryAddr.toLowerCase()) {
    throw new PublishError('PUBLISH_RESUME_REQUIRED', 'Publish state does not match the current Factory deployment.', 3, 'resume');
  }
  const contentKey = state.stage === 'key_set'
    ? null
    : openRecoverySecret(
        state.sealedContentKey,
        context.privateKey,
        recoveryContext(context.client.origin, slug, state.walletAddr),
      );
  return finishPublish(state, context, contentKey);
}

async function newPublish(pathArg, options, validated) {
  const context = await authenticatedContext();
  const { client, cfg, privateKey, account } = context;
  const chain = resolveChain(options.chain || cfg.chain);
  const cover = resolveCoverOption(options.cover);
  let source;
  try {
    source = collectPublishSource(pathArg);
  } catch (error) {
    throw new PublishError('SOURCE_UNSAFE', error instanceof Error ? error.message : 'Source validation failed.', 3, 'validation');
  }
  if (source.excludedSensitivePaths.length && !options.json) {
    const preview = source.excludedSensitivePaths.slice(0, 5).join(', ');
    const remainder = source.excludedSensitivePaths.length > 5
      ? `, +${source.excludedSensitivePaths.length - 5} more`
      : '';
    wrn(`Excluded sensitive files from the publish bundle: ${preview}${remainder}`);
  }
  const primary = source.files[source.primaryIndex];
  const primaryBytes = readFileSync(primary.absolute);
  const bundleBytes = buildSourceBundle(source);
  const contentKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const encryptedPrimary = await encryptArtifact(primaryBytes, contentKey);
  const encryptedBundle = bundleBytes ? await encryptArtifact(bundleBytes, contentKey) : null;
  if (encryptedPrimary.length > PRIMARY_MAX_ENCRYPTED_BYTES) throw new PublishError('SOURCE_TOO_LARGE', 'Encrypted primary source exceeds 2 MB.', 3, 'validation');
  if (encryptedBundle && encryptedBundle.length > BUNDLE_MAX_ENCRYPTED_BYTES) throw new PublishError('SOURCE_TOO_LARGE', 'Encrypted source ZIP exceeds 10 MB.', 3, 'validation');

  const proto = await resolveProtocol(chain.id, cfg.rpc);
  if (proto.factoryPaused) throw new PublishError('DEPLOY_FAILED', 'Factory is paused on this chain.', 3, 'validation');
  const publicClient = getPublicClient(chain.id, cfg.rpc);
  const { client: walletClient } = getWalletClient(chain.id, privateKey, cfg.rpc);
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) throw new PublishError('DEPLOY_FAILED', `Wallet has no ${chain.symbol} for gas.`, 3, 'validation');

  const availability = await apiJson(client, `/api/skills/availability?slug=${encodeURIComponent(validated.slug)}`);
  if (!availability.response.ok) throw new PublishError('PUBLISH_FAILED', availability.payload.error || 'Slug availability check failed.', 5, 'validation');
  if (availability.payload.available === false) throw new PublishError('SLUG_TAKEN', `Skill slug ${validated.slug} is already taken.`, 3, 'validation');

  const dryArgs = [
    options.name.trim(), validated.slug, 'ipfs://dry-run-metadata', `0x${'0'.repeat(64)}`, 'ipfs://dry-run-source',
    options.category, options.license, 0, validated.priceWei, BigInt(validated.maxSupply), BigInt(validated.royaltyBps),
    cover.imageURI, 0n,
  ];
  let gasEstimate = null;
  try {
    gasEstimate = await publicClient.estimateContractGas({
      address: proto.factory, abi: FACTORY_ABI, functionName: 'deployChip', args: dryArgs, account: account.address,
    });
  } catch (error) {
    throw new PublishError('DEPLOY_FAILED', `Deploy simulation failed: ${error.shortMessage || error.message}`, 3, 'validation');
  }
  if (options.dryRun) {
    return {
      ok: true, code: 'PUBLISH_DRY_RUN', stage: 'validated', slug: validated.slug, chainId: chain.id,
      walletAddr: account.address.toLowerCase(), primary: primary.relative, fileCount: source.files.length,
      sourceFiles: source.files.map(file => file.relative),
      excludedSensitiveFiles: source.excludedSensitivePaths,
      primaryEncryptedBytes: encryptedPrimary.length, bundleEncryptedBytes: encryptedBundle?.length || 0,
      estimatedGas: gasEstimate.toString(), balance: formatEther(balance),
    };
  }

  const uploaded = [];
  let broadcast = false;
  try {
    const primaryPin = await uploadFile(client, encryptedPrimary, `${basename(primary.relative)}.enc`, 'package');
    uploaded.push(primaryPin.uploadId);
    const primaryArtifact = {
      uri: primaryPin.uri, cid: primaryPin.cid || String(primaryPin.uri).slice(7), filename: primary.relative,
      sizeBytes: encryptedPrimary.length, plaintextSha256: sha256Hex(primaryBytes), encryptedSha256: sha256Hex(encryptedPrimary),
    };
    let bundleArtifact = null;
    if (encryptedBundle) {
      const bundlePin = await uploadFile(client, encryptedBundle, `${validated.slug}-source.zip.enc`, 'package');
      uploaded.push(bundlePin.uploadId);
      bundleArtifact = {
        uri: bundlePin.uri, cid: bundlePin.cid || String(bundlePin.uri).slice(7), filename: 'source.zip',
        sizeBytes: encryptedBundle.length, plaintextSha256: sha256Hex(bundleBytes), encryptedSha256: sha256Hex(encryptedBundle),
      };
    }
    const manifest = buildContentManifest(primaryArtifact, bundleArtifact);
    const manifestPin = await uploadFile(client, manifest.bytes, 'finchip-content-manifest.json', 'package');
    uploaded.push(manifestPin.uploadId);

    let imageURI = cover.imageURI;
    if (cover.path) {
      const coverPin = await uploadFile(client, readFileSync(cover.path), basename(cover.path), 'cover');
      uploaded.push(coverPin.uploadId);
      imageURI = coverPin.uri;
    }
    const metadataPin = await uploadMetadata(client, {
      name: options.name.trim(), description: options.description.trim(), category: options.category,
      license: options.license, version: options.version, deploymentSlug: validated.slug, imageURI,
    });
    uploaded.push(metadataPin.uploadId);

    const args = [
      options.name.trim(), validated.slug, metadataPin.uri, manifest.contentHash, manifestPin.uri,
      options.category, options.license, 0, validated.priceWei, BigInt(validated.maxSupply), BigInt(validated.royaltyBps), imageURI, 0n,
    ];
    const deployTxHash = await walletClient.writeContract({
      address: proto.factory, abi: FACTORY_ABI, functionName: 'deployChip', args,
    });
    broadcast = true;
    const registerBase = {
      tx_hash: deployTxHash, chain_id: chain.id,
      name: options.name.trim(), slug: validated.slug, creator_addr: account.address.toLowerCase(), category: options.category,
      tags: String(options.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), license: options.license,
      description: options.description.trim(), version: options.version, source_url: manifestPin.uri,
      source_filename: primary.relative, encrypt_mode: 'finchip', market_eligible: false, metadata_uri: metadataPin.uri,
      token_type: 'erc1155', price_wei: validated.priceWei.toString(), royalty_bps: validated.royaltyBps,
      max_supply: validated.maxSupply, fee_model: 0,
    };
    const state = {
      version: 1, origin: client.origin, slug: validated.slug, stage: 'broadcast', walletAddr: account.address.toLowerCase(),
      chainId: chain.id, uploadIds: uploaded, metadataUri: metadataPin.uri, sourceUri: manifestPin.uri,
      deployTxHash, factoryAddr: proto.factory, contractAddr: null, registerBase, sealedContentKey: sealRecoverySecret(
        contentKey, privateKey, recoveryContext(client.origin, validated.slug, account.address),
      ),
      sourceFiles: source.files.map(file => file.relative),
      excludedSensitiveFiles: source.excludedSensitivePaths,
    };
    savePublishState(client.origin, validated.slug, state);
    await updateUploads(client, '/api/skills/me/ipfs/finalize', { uploadIds: uploaded, status: 'tx_submitted', txHash: deployTxHash });
    return finishPublish(state, context, contentKey);
  } catch (error) {
    if (!broadcast && uploaded.length) {
      await updateUploads(client, '/api/skills/me/ipfs/cleanup', { uploadIds: uploaded }).catch(() => {});
    }
    if (broadcast && !(error instanceof PublishError)) {
      throw new PublishError(
        'PUBLISH_RESUME_REQUIRED',
        `Publish transaction was submitted but the workflow did not finish: ${error instanceof Error ? error.message : 'unknown error'}`,
        5,
        'resume',
      );
    }
    throw error;
  }
}

export async function cmdPublish(pathArg, options = {}) {
  try {
    const validated = validateOptions(pathArg, options);
    const result = options.resume
      ? await resumePublish(validated.slug, options)
      : await newPublish(pathArg, {
          category: 'General', license: 'MIT', version: '1.0.0', royaltyBps: '500', maxSupply: '0', ...options,
        }, validated);
    emitResult(options, result, () => {
      hd(options.dryRun ? 'FinChip CLI — publish dry run' : 'FinChip CLI — publish');
      sep();
      ok(result.code === 'PUBLISH_COMPLETE' ? `Published ${result.slug}` : `Validated ${result.slug}`);
      inf(`chain:    ${fmtChain(result.chainId)}`);
      if (result.contractAddr) inf(`contract: ${fmtAddr(result.contractAddr)}`);
      if (result.txHash) inf(`tx:       ${result.txHash}`);
      if (result.estimatedGas) inf(`gas:      ${result.estimatedGas}`);
    });
  } catch (error) {
    fail(options, error);
  }
}
