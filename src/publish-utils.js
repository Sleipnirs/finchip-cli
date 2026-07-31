import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import { zipSync } from 'fflate';
import { writePrivateTextFile } from './private-files.js';
export { canonicalSlug, siteCanonicalSlug, siteLookupSlug } from './skill-slug.js';

export const DEFAULT_CHIP_LOGO_URI = 'ipfs://bafybeiaal47ha2ovfvttgiox4a6xzo4hes4kavjtpuhkrpagud5wjj7yl4';
export const PRIMARY_MAX_ENCRYPTED_BYTES = 2 * 1024 * 1024;
export const BUNDLE_MAX_ENCRYPTED_BYTES = 10 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const MANIFEST_HASH_SCHEME = 'finchip-ipfs-content-manifest-v1';

const STATE_VERSION = 1;
const DEFAULT_STATE_PATH = join(homedir(), '.finchip', 'publish-state.json');
const SOURCE_EXTENSIONS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.sol']);
const SENSITIVE_PARTS = new Set([
  '.git',
  'node_modules',
  '.finchip',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.terraform',
]);
const GENERATED_PARTS = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.parcel-cache',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
]);
const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.gitconfig',
  '.htpasswd',
  'auth.json',
  'credentials',
  'credentials.json',
  'publish-state.json',
  'application_default_credentials.json',
  'credentials.db',
  'cookies.txt',
]);
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*private[-_]?key.*|keystore(?:[-_].*)?|wallet[-_](?:backup|key|secret).*|.*service[-_]?account.*\.json)$/i;
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx']);
const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.config\/(?:gh|gcloud)\//i,
  /(?:^|\/)[^/]+\.tfvars(?:\.json)?$/i,
  /(?:^|\/)[^/]+\.tfstate(?:\.backup)?$/i,
  /(?:^|\/)[^/]+\.kubeconfig$/i,
];

export function isSensitiveSourcePath(path) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const normalized = parts.join('/');
  const basenameLower = parts.at(-1)?.toLowerCase() || '';
  return parts.some(part => SENSITIVE_PARTS.has(part.toLowerCase()))
    || SENSITIVE_BASENAMES.has(basenameLower)
    || parts.some(part => SENSITIVE_NAMES.test(part))
    || SENSITIVE_EXTENSIONS.has(extname(path).toLowerCase())
    || SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

function generatedSourcePath(path) {
  return path.split(/[\\/]+/).filter(Boolean)
    .some(part => GENERATED_PARTS.has(part.toLowerCase()));
}

function exclusionReason(path, { excludeGenerated = false } = {}) {
  if (excludeGenerated && generatedSourcePath(path)) return 'generated';
  if (isSensitiveSourcePath(path)) return 'sensitive';
  return null;
}

function gitFiles(directory) {
  let isRepository;
  try {
    isRepository = execFileSync(
      'git',
      ['-C', directory, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim() === 'true';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.status === 128) return null;
    throw new Error(`Could not inspect the source Git repository: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!isRepository) return null;

  let output;
  try {
    output = execFileSync(
      'git',
      ['-C', directory, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    throw new Error(`Could not enumerate the source Git repository: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const candidates = output.toString('utf8').split('\0').filter(Boolean).map(file => {
    const normalizedFile = file.split(/[\\/]+/).join('/');
    return {
      absolute: join(directory, normalizedFile),
      relative: normalizedFile,
    };
  });
  const files = [];
  const excludedFiles = [];
  for (const file of candidates) {
    const reason = exclusionReason(file.relative);
    if (reason) {
      excludedFiles.push({ path: file.relative, reason });
      continue;
    }
    const info = lstatSync(file.absolute);
    if (info.isSymbolicLink()) {
      excludedFiles.push({ path: file.relative, reason: 'symlink' });
    } else if (info.isFile()) {
      files.push(file);
    } else {
      excludedFiles.push({ path: file.relative, reason: 'unsupported' });
    }
  }
  return {
    collectionMode: 'git',
    files,
    excludedFiles,
  };
}

function directoryFiles(directory) {
  const files = [];
  const excludedFiles = [];

  function walk(absoluteDirectory, relativeDirectory = '') {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const reason = exclusionReason(relative, { excludeGenerated: true });
      if (reason) {
        excludedFiles.push({ path: relative, reason });
        continue;
      }
      const absolute = join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        excludedFiles.push({ path: relative, reason: 'symlink' });
      } else if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
      } else {
        excludedFiles.push({ path: relative, reason: 'unsupported' });
      }
    }
  }

  walk(directory);
  return {
    collectionMode: 'directory',
    files,
    excludedFiles,
  };
}

export function collectPublishSource(inputPath) {
  const absolute = resolve(inputPath);
  if (!existsSync(absolute)) throw new Error(`Source not found: ${absolute}`);
  const info = lstatSync(absolute);
  if (info.isFile()) {
    if (isSensitiveSourcePath(basename(absolute))) throw new Error('The selected source file looks like a credential or private key.');
    return {
      root: dirname(absolute),
      files: [{ absolute, relative: basename(absolute) }],
      collectionMode: 'file',
      excludedFiles: [],
      excludedSensitivePaths: [],
      primaryIndex: 0,
      buildZip: false,
    };
  }
  if (!info.isDirectory()) throw new Error('Source must be a regular file or directory.');
  const root = realpathSync(absolute);
  const collected = gitFiles(root) || directoryFiles(root);
  const files = collected.files;
  if (!files.length) throw new Error('No publishable files remain after source safety filtering.');
  const primaryIndex = selectPrimaryIndex(files.map(file => file.relative));
  return {
    root,
    files,
    collectionMode: collected.collectionMode,
    excludedFiles: collected.excludedFiles,
    // Retain the original JSON field for compatibility. It historically also
    // included dependency trees such as node_modules, not only credentials.
    excludedSensitivePaths: collected.excludedFiles.map(file => file.path),
    primaryIndex,
    buildZip: files.length > 1,
  };
}

export function selectPrimaryIndex(paths) {
  let index = paths.findIndex(path => basename(path).toLowerCase() === 'skill.md');
  if (index >= 0) return index;
  index = paths.findIndex(path => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()));
  return index >= 0 ? index : 0;
}

export function buildSourceBundle(source) {
  if (!source.buildZip) return null;
  const entries = {};
  for (const file of source.files) entries[file.relative] = new Uint8Array(readFileSync(file.absolute));
  return Buffer.from(zipSync(entries, { level: 6 }));
}

export async function encryptArtifact(plaintext, key) {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const iv = randomBytes(12);
  const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, bytes);
  return Buffer.concat([iv, Buffer.from(encrypted)]);
}

export function sha256Hex(input) {
  return `0x${createHash('sha256').update(input).digest('hex')}`;
}

function stableValue(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
}

export function buildContentManifest(primary, bundleZip = null) {
  const manifest = { version: 1, hashScheme: MANIFEST_HASH_SCHEME, primary, bundleZip };
  const bytes = Buffer.from(stableValue(manifest), 'utf8');
  if (bytes.length > MANIFEST_MAX_BYTES) throw new Error('Content manifest exceeds 256 KB.');
  return { manifest, bytes, contentHash: sha256Hex(bytes) };
}

function statePath(override) {
  return override || process.env.FINCHIP_PUBLISH_STATE_PATH || DEFAULT_STATE_PATH;
}

function emptyStateStore() {
  return { version: STATE_VERSION, profiles: {} };
}

export function readPublishStateStore(path = statePath()) {
  if (!existsSync(path)) return emptyStateStore();
  try {
    const store = JSON.parse(readFileSync(path, 'utf8'));
    return store?.version === STATE_VERSION && store.profiles && typeof store.profiles === 'object' ? store : emptyStateStore();
  } catch {
    return emptyStateStore();
  }
}

function writePublishStateStore(store, path) {
  writePrivateTextFile(path, `${JSON.stringify(store, null, 2)}\n`);
}

export function savePublishState(origin, slug, state, options = {}) {
  const path = statePath(options.path);
  const store = readPublishStateStore(path);
  store.profiles[origin] ||= {};
  store.profiles[origin][slug] = { ...state, updatedAt: new Date().toISOString() };
  writePublishStateStore(store, path);
}

export function loadPublishState(origin, slug, options = {}) {
  return readPublishStateStore(statePath(options.path)).profiles?.[origin]?.[slug] || null;
}

export function clearPublishState(origin, slug, options = {}) {
  const path = statePath(options.path);
  const store = readPublishStateStore(path);
  if (store.profiles?.[origin]) {
    delete store.profiles[origin][slug];
    if (!Object.keys(store.profiles[origin]).length) delete store.profiles[origin];
  }
  writePublishStateStore(store, path);
}

function recoveryKey(privateKey, salt, context) {
  const ikm = Buffer.from(privateKey.replace(/^0x/, ''), 'hex');
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`finchip-publish-state-v1:${context}`), 32));
}

export function sealRecoverySecret(secret, privateKey, context) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', recoveryKey(privateKey, salt, context), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function openRecoverySecret(sealed, privateKey, context) {
  try {
    const salt = Buffer.from(sealed.salt, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', recoveryKey(privateKey, salt, context), Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Publish recovery state cannot be opened with this wallet private key.');
  }
}

export function wrapFinchipV2ContentKey(serverKey, contentKey) {
  const key = Buffer.from(String(serverKey).replace(/^0x/, ''), 'hex');
  if (key.length !== 32) throw new Error('FinChip key service returned an invalid server key.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(Buffer.from(contentKey).toString('base64'), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

export function wrapOracleV2ContentKey(serverKey, contentKey) {
  const key = Buffer.from(String(serverKey).replace(/^0x/, ''), 'hex');
  const plaintext = Buffer.from(contentKey);
  if (key.length !== 32) throw new Error('FinChip key service returned an invalid Oracle V2 key.');
  if (plaintext.length !== 32) throw new Error('Oracle V2 requires a raw 32-byte content key.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}
