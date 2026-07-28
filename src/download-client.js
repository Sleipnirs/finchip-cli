import { createHash } from 'node:crypto';
import { DownloadError } from './download-decryption.js';

export { DownloadError };

const SOURCE_KINDS = new Set(['github', 'ipfs_plain', 'ipfs_encrypted', 'ipfs_manifest_v1']);
const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

function sourceError(response, payload = {}) {
  const code = payload.code;
  if (code === 'LICENSE_REQUIRED') return new DownloadError('LICENSE_REQUIRED', payload.error || 'A license is required.', 3);
  if (code === 'CHAIN_RPC_UNAVAILABLE') return new DownloadError('CHAIN_RPC_UNAVAILABLE', payload.error || 'Site could not verify on-chain access.', 5);
  if (code === 'DOWNLOAD_LINK_EXPIRED' || response.status === 410) {
    return new DownloadError('DOWNLOAD_LINK_EXPIRED', payload.error || 'Download link expired.', 5, { refreshManifest: true });
  }
  const stable = code || (response.status === 404 ? 'SOURCE_NOT_AVAILABLE' : 'SOURCE_DOWNLOAD_FAILED');
  return new DownloadError(stable, payload.error || `Source request failed (${response.status}).`, response.status >= 500 ? 5 : 3);
}

export function validateSourceManifest(value) {
  if (!value || typeof value !== 'object' || !SOURCE_KINDS.has(value.kind)) {
    throw new DownloadError('SOURCE_NOT_AVAILABLE', `Unsupported source kind: ${value?.kind || '(missing)'}`, 3);
  }
  if (!Array.isArray(value.files) || !value.files.length || typeof value.packageDownloadUrl !== 'string') {
    throw new DownloadError('SOURCE_NOT_AVAILABLE', 'Source manifest has no downloadable package.', 3);
  }
  if (
    value.kind === 'ipfs_manifest_v1'
    && (
      typeof value.manifestUri !== 'string'
      || !value.manifestUri.startsWith('ipfs://')
      || !HEX_32_RE.test(value.manifestSha256 || '')
    )
  ) {
    throw new DownloadError('SOURCE_NOT_AVAILABLE', 'Verified IPFS manifest metadata is invalid.', 3);
  }
  return value;
}

export function canonicalSkillViewerContent({ slug, addr, chainId }) {
  return JSON.stringify({
    slug,
    addr: addr?.trim().toLowerCase() || null,
    chainId: chainId ?? null,
  });
}

export function buildV2WriteMessage({ slug, wallet, contentHash, timestamp }) {
  return [
    'FinChip V2',
    'Action: skill_detail_viewer',
    `Slug: ${slug}`,
    `Wallet: ${wallet.toLowerCase()}`,
    `Content Hash: ${contentHash}`,
    `Timestamp: ${timestamp}`,
  ].join('\n');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function requestSourceManifest({
  client,
  slug,
  deployment,
  account,
  now = Date.now,
}) {
  const path = `/api/v2/skills/${encodeURIComponent(slug)}/source/manifest`;
  const baseBody = { addr: deployment.addr, chainId: deployment.chainId };
  let first;
  try {
    first = await client.json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseBody),
      timeoutMs: 30_000,
    });
  } catch {
    throw new DownloadError('SOURCE_DOWNLOAD_FAILED', 'Unable to reach the FinChip source service.', 5);
  }
  if (first.response.ok) return validateSourceManifest(first.payload);
  if (first.response.status !== 401) throw sourceError(first.response, first.payload);
  if (!account) {
    throw new DownloadError('AUTH_REQUIRED', 'Run `finchip login` or configure an Agent wallet to prove wallet ownership.', 2);
  }

  const timestamp = now();
  const wallet = account.address.toLowerCase();
  const contentHash = sha256Text(canonicalSkillViewerContent({ slug, ...baseBody }));
  const message = buildV2WriteMessage({ slug, wallet, contentHash, timestamp });
  let signature;
  try {
    signature = await account.signMessage({ message });
  } catch {
    throw new DownloadError('AUTH_SIGNATURE_FAILED', 'Wallet could not sign the source access request.', 3);
  }
  let signed;
  try {
    signed = await client.json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...baseBody,
        wallet_addr: wallet,
        signature,
        message,
        timestamp,
        content_hash: contentHash,
        signature_chain_id: deployment.chainId,
      }),
      timeoutMs: 30_000,
    });
  } catch {
    throw new DownloadError('SOURCE_DOWNLOAD_FAILED', 'Unable to confirm the signed source access request.', 5);
  }
  if (!signed.response.ok) throw sourceError(signed.response, signed.payload);
  return validateSourceManifest(signed.payload);
}

export async function downloadPackage(client, packageDownloadUrl) {
  let url;
  try { url = new URL(packageDownloadUrl, `${client.origin}/`); }
  catch { throw new DownloadError('SOURCE_NOT_AVAILABLE', 'Source package URL is invalid.', 3); }
  if (url.origin !== client.origin) {
    throw new DownloadError('SOURCE_ORIGIN_MISMATCH', 'Source package URL must stay on the configured FinChip Site origin.', 3);
  }
  const path = `${url.pathname}${url.search}`;
  let response;
  try {
    response = await client.request(path, { cache: 'no-store', timeoutMs: 60_000 });
  } catch {
    throw new DownloadError('SOURCE_DOWNLOAD_FAILED', 'Unable to download the source package from FinChip.', 5);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw sourceError(response, payload);
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentDisposition: response.headers.get('content-disposition'),
    contentType: response.headers.get('content-type'),
  };
}

export function ipfsGatewayUrls(uri) {
  const path = String(uri || '').trim().replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
  if (!path || path === String(uri || '').trim()) return [];
  return [
    `https://ipfs.io/ipfs/${path}`,
    `https://gateway.pinata.cloud/ipfs/${path}`,
    `https://cloudflare-ipfs.com/ipfs/${path}`,
  ];
}

export async function fetchIpfsBytes(uri, fetchImpl = globalThis.fetch) {
  const urls = ipfsGatewayUrls(uri);
  if (!urls.length) throw new DownloadError('SOURCE_NOT_AVAILABLE', 'Source manifest is not an IPFS URI.', 3);
  let diagnostic = '';
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', redirect: 'follow' });
      if (!response.ok) {
        diagnostic = String(response.status);
        continue;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : 'network error';
    }
  }
  throw new DownloadError('SOURCE_HOST_UNAVAILABLE', `Could not fetch IPFS content${diagnostic ? ` (${diagnostic})` : ''}.`, 5);
}
