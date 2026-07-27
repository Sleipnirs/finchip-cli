import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

import { FinchipAuthClient } from '../auth-client.js';
import { resolveChain } from '../chains.js';
import { getPublicClient } from '../client.js';
import { loadConfig, resolveWalletPrivateKey, WalletKeyError } from '../config.js';
import {
  downloadPackage,
  fetchIpfsBytes,
  requestSourceManifest,
} from '../download-client.js';
import {
  DownloadError,
  requestPackageKey,
  resolveEncryptionMode,
} from '../download-decryption.js';
import {
  decryptAesGcmPackage,
  downloadNameFromContent,
  filenameFromContentDisposition,
  integrityLevelForSource,
  parseAndVerifyContentManifest,
  safeDownloadName,
  sha256Hex,
  verifySha256,
  withOracleV2Provenance,
} from '../download-utils.js';
import { writePrivateBinaryFile } from '../private-files.js';
import { CHIP_ABI } from '../protocol.js';
import { emitFailure, emitResult, hd, inf, ok, sep, wrn } from '../utils.js';

function validateOptions(options) {
  if (Boolean(options.addr) !== Boolean(options.chain)) {
    throw new DownloadError('DOWNLOAD_DEPLOYMENT_REQUIRED', '--addr and --chain must be provided together.', 3);
  }
  if (options.addr && !/^0x[0-9a-fA-F]{40}$/.test(options.addr)) {
    throw new DownloadError('DOWNLOAD_DEPLOYMENT_REQUIRED', 'Invalid contract address.', 3);
  }
  return options.addr
    ? { addr: options.addr.toLowerCase(), chainId: resolveChain(options.chain).id }
    : null;
}

async function resolveDeployment(client, slug, requested) {
  if (requested) return { slug, ...requested };
  let detail;
  try {
    detail = await client.json(`/api/v2/skills/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      timeoutMs: 30_000,
    });
  } catch {
    throw new DownloadError('SOURCE_DOWNLOAD_FAILED', 'Unable to resolve the Skill deployment from FinChip.', 5);
  }
  const { response, payload } = detail;
  if (!response.ok) {
    throw new DownloadError(
      response.status === 404 ? 'SKILL_NOT_FOUND' : 'SOURCE_NOT_AVAILABLE',
      payload.error || `Skill lookup failed (${response.status}).`,
      response.status >= 500 ? 5 : 3,
    );
  }
  const addr = payload.skill?.chip_address;
  const chainId = Number(payload.skill?.chain_id);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '') || !Number.isInteger(chainId)) {
    throw new DownloadError('SOURCE_NOT_AVAILABLE', 'Skill is not linked to a canonical on-chain deployment.', 3);
  }
  resolveChain(chainId);
  return { slug: payload.skill?.slug || slug, addr: addr.toLowerCase(), chainId };
}

async function validateActiveSession(client, account) {
  if (!client.hasPersistedCredentials()) return null;
  const session = await client.getSession();
  if (!session.authenticated) {
    client.clearCredentials();
    return null;
  }
  const sessionWallet = session.wallet?.walletAddr?.toLowerCase()
    || session.identity?.walletAddr?.toLowerCase()
    || null;
  if (account && sessionWallet && sessionWallet !== account.address.toLowerCase()) {
    throw new DownloadError('WALLET_MISMATCH', 'Cookie wallet and configured private key must match.', 3);
  }
  return session;
}

function selectedManifestFile(manifest) {
  return manifest.files.find(file => file.artifactRole === 'bundleZip')
    || manifest.files.find(file => file.artifactRole === 'primary')
    || manifest.files.find(file => file.downloadable !== false)
    || manifest.files[0];
}

async function verifiedManifestArtifact({ manifest, publicClient, deployment, fetchIpfs }) {
  let contentHash;
  let sourceUrl;
  try {
    [contentHash, sourceUrl] = await Promise.all([
      publicClient.readContract({ address: deployment.addr, abi: CHIP_ABI, functionName: 'contentHash' }),
      publicClient.readContract({ address: deployment.addr, abi: CHIP_ABI, functionName: 'sourceUrl' }),
    ]);
  } catch {
    throw new DownloadError('CHAIN_RPC_UNAVAILABLE', 'Could not read the on-chain source manifest.', 5);
  }
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('ipfs://')) {
    throw new DownloadError('SOURCE_NOT_AVAILABLE', 'On-chain source URL is not an IPFS content manifest.', 3);
  }
  if (manifest.manifestUri !== sourceUrl || manifest.manifestSha256.toLowerCase() !== String(contentHash).toLowerCase()) {
    throw new DownloadError('DECRYPT_FAILED', 'Site source manifest metadata does not match the on-chain source.', 3);
  }
  const manifestBytes = await fetchIpfs(sourceUrl);
  let verified;
  try {
    verified = parseAndVerifyContentManifest(manifestBytes, contentHash);
  } catch (error) {
    throw new DownloadError('DECRYPT_FAILED', error?.message || 'On-chain content manifest verification failed.', 3);
  }
  return verified.artifact;
}

async function processManifest({
  manifest,
  client,
  account,
  deployment,
  cfg,
  options,
  deps,
}) {
  const integrityLevel = integrityLevelForSource(manifest.kind);
  const publicClient = deps.publicClient || getPublicClient(deployment.chainId, cfg.rpc);
  let expectedArtifact = null;
  if (manifest.kind === 'ipfs_manifest_v1') {
    expectedArtifact = await verifiedManifestArtifact({
      manifest,
      publicClient,
      deployment,
      fetchIpfs: deps.fetchIpfs || fetchIpfsBytes,
    });
  }

  const downloaded = await (deps.downloadPackage || downloadPackage)(client, manifest.packageDownloadUrl);
  const file = selectedManifestFile(manifest);
  const encrypted = manifest.kind === 'ipfs_manifest_v1'
    || manifest.kind === 'ipfs_encrypted'
    || file.encrypted === true;
  const expectedEncryptedHash = expectedArtifact?.encryptedSha256 || file.encryptedSha256 || null;
  const expectedPlaintextHash = expectedArtifact?.plaintextSha256 || file.plaintextSha256 || null;
  if (expectedEncryptedHash) {
    try {
      verifySha256(downloaded.bytes, expectedEncryptedHash, 'Encrypted package');
    } catch (error) {
      throw new DownloadError('DECRYPT_FAILED', error.message, 3);
    }
  }

  let outputBytes = downloaded.bytes;
  let encryptionMode = null;
  let provenanceId = null;
  let verifiedPlaintextSha256 = null;
  if (encrypted) {
    if (!account) {
      throw new DownloadError('AUTH_REQUIRED', 'Encrypted downloads require a configured Agent wallet to sign the decrypt request.', 2);
    }
    let litData;
    try {
      litData = await publicClient.readContract({
        address: deployment.addr,
        abi: CHIP_ABI,
        functionName: 'getLitData',
      });
    } catch {
      throw new DownloadError('CHAIN_RPC_UNAVAILABLE', 'Could not read the on-chain encryption envelope.', 5);
    }
    const [ciphertext, marker] = litData;
    encryptionMode = resolveEncryptionMode(marker);
    const keyResult = await (deps.requestPackageKey || requestPackageKey)({
      mode: encryptionMode,
      ciphertext,
      client,
      account,
      chipAddress: deployment.addr,
      chainId: deployment.chainId,
    });
    provenanceId = keyResult.provenanceId;
    try {
      outputBytes = await decryptAesGcmPackage(downloaded.bytes, keyResult.key);
    } catch (error) {
      throw new DownloadError('DECRYPT_FAILED', error?.message || 'Source package authentication failed.', 3);
    } finally {
      if (Buffer.isBuffer(keyResult.key)) keyResult.key.fill(0);
    }
    if (expectedPlaintextHash) {
      try {
        verifiedPlaintextSha256 = verifySha256(outputBytes, expectedPlaintextHash, 'Decrypted package');
      } catch (error) {
        throw new DownloadError('DECRYPT_FAILED', error.message, 3);
      }
    }
  }

  let provenanceInjected = false;
  if (
    encryptionMode === 'oracle-v2'
    && provenanceId
    && verifiedPlaintextSha256
    && options.provenance !== false
  ) {
    const decorated = await withOracleV2Provenance(outputBytes, {
      grantId: provenanceId,
      walletAddress: account.address,
      chipAddress: deployment.addr,
      chainId: deployment.chainId,
    });
    outputBytes = decorated.bytes;
    provenanceInjected = decorated.injected;
  }

  const preferredName = expectedArtifact?.filename
    || filenameFromContentDisposition(downloaded.contentDisposition)
    || file.name
    || `${deployment.slug}-source-package`;
  const outputName = downloadNameFromContent(preferredName, outputBytes, encrypted);
  const outputPath = resolve(options.dir || '.', safeDownloadName(outputName));
  try {
    (deps.writeOutput || writePrivateBinaryFile)(outputPath, outputBytes, { force: options.force === true });
  } catch (error) {
    if (/already exists/i.test(error?.message || '')) {
      throw new DownloadError('OUTPUT_EXISTS', error.message, 3, { outputPath });
    }
    throw new DownloadError('OUTPUT_WRITE_FAILED', error?.message || 'Could not save the downloaded package.', 5, { outputPath });
  }
  const outputSha256 = sha256Hex(outputBytes);
  return {
    ok: true,
    code: 'DOWNLOAD_COMPLETE',
    slug: deployment.slug,
    chainId: deployment.chainId,
    contractAddr: deployment.addr,
    sourceKind: manifest.kind,
    encryptionMode,
    outputPath,
    bytes: outputBytes.length,
    integrityLevel,
    verifiedPlaintextSha256,
    outputSha256,
    provenanceInjected,
    provenanceId,
    outputDiffersFromVerifiedPlaintext: Boolean(
      verifiedPlaintextSha256
      && verifiedPlaintextSha256.toLowerCase() !== outputSha256.toLowerCase()
    ),
  };
}

export async function downloadSkill(slug, options = {}, deps = {}) {
  const requested = validateOptions(options);
  const cfg = deps.cfg || loadConfig();
  const privateKey = deps.privateKey === undefined
    ? resolveWalletPrivateKey(cfg, { required: false })
    : deps.privateKey;
  const account = deps.account || (privateKey ? privateKeyToAccount(privateKey) : null);
  const client = deps.client || new FinchipAuthClient();
  await validateActiveSession(client, account);
  const deployment = await resolveDeployment(client, slug, requested);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifest = await (deps.requestSourceManifest || requestSourceManifest)({
      client,
      slug: deployment.slug,
      deployment,
      account,
    });
    try {
      return await processManifest({ manifest, client, account, deployment, cfg, options, deps });
    } catch (error) {
      if (error?.code === 'DOWNLOAD_LINK_EXPIRED' && attempt === 0) continue;
      throw error;
    }
  }
  throw new DownloadError('DOWNLOAD_LINK_EXPIRED', 'Download link expired after refresh.', 5);
}

function fail(options, error) {
  const normalized = error instanceof DownloadError || error instanceof WalletKeyError
    ? error
    : new DownloadError('DOWNLOAD_FAILED', error instanceof Error ? error.message : 'Download failed.');
  emitFailure(options, normalized, { code: 'DOWNLOAD_FAILED' });
}

export async function cmdDownload(slug, options = {}) {
  try {
    const result = await downloadSkill(slug, options);
    emitResult(options, result, () => {
      hd('FinChip CLI — download');
      sep();
      ok(`${result.slug} saved`);
      inf(`source:     ${result.sourceKind}`);
      inf(`encryption: ${result.encryptionMode || 'none'}`);
      inf(`integrity:  ${result.integrityLevel}`);
      inf(`output:     ${result.outputPath}`);
      inf(`sha256:     ${result.outputSha256}`);
      if (result.integrityLevel === 'aead-only') {
        wrn('Integrity is AES-GCM authentication only; this legacy source has no independent content hash.');
      }
      if (result.outputDiffersFromVerifiedPlaintext) {
        wrn('Output hash differs from the verified plaintext because .finchip-provenance.json was injected. Use --no-provenance for original bytes.');
      } else if (result.encryptionMode === 'oracle-v2' && result.provenanceId && !result.provenanceInjected) {
        inf('provenance: not injected (disabled or package format was not safe to rewrite)');
      }
    });
  } catch (error) {
    fail(options, error);
  }
}
