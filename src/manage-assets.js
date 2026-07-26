import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

import { ManageError } from './manage-config.js';

export const MANAGE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const PAGE_KINDS = Object.freeze(['instruction', 'benchmark', 'showcase']);

const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const IMAGE_FORMATS = Object.freeze({
  '.jpg': {
    mime: 'image/jpeg',
    matches: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  '.jpeg': {
    mime: 'image/jpeg',
    matches: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  '.png': {
    mime: 'image/png',
    matches: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  '.webp': {
    mime: 'image/webp',
    matches: bytes => bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  '.gif': {
    mime: 'image/gif',
    matches: bytes => bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
  },
});

function invalid(message) {
  throw new ManageError('MANAGE_INVALID', message, 3);
}

function readRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    invalid(`${label} could not be read: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) invalid(`${label} must be a regular file, not a symlink.`);
  if (stat.size > MANAGE_UPLOAD_MAX_BYTES) {
    throw new ManageError('MANAGE_UPLOAD_TOO_LARGE', `${label} must be 4 MiB or smaller.`, 3);
  }
  return { stat, bytes: readFileSync(path) };
}

export function loadImageUpload(path) {
  const name = basename(path);
  if (!SAFE_IMAGE_NAME.test(name)) invalid('Image filename contains unsupported characters.');
  const format = IMAGE_FORMATS[extname(name).toLowerCase()];
  if (!format) invalid('Image extension must be .jpg, .jpeg, .png, .webp, or .gif.');
  const { bytes } = readRegularFile(path, 'Image');
  if (!format.matches(bytes)) invalid('Image magic bytes do not match its extension and MIME type.');
  return { name, mime: format.mime, bytes };
}

function assetMime(name) {
  const ext = extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.md') return 'text/plain';
  return 'application/octet-stream';
}

function validateHtml(html) {
  if (/<script[\s>]/i.test(html)) invalid('HTML cannot include <script> tags.');
  if (/\b(?:src|href)\s*=\s*["']\/(?!\/)/i.test(html)) {
    invalid('HTML must use relative local paths, not root-absolute paths.');
  }
  if (/\b(?:src|href)\s*=\s*["']\.\/assets\/[^"']*\/[^"']*["']/i.test(html)) {
    invalid('Only flat ./assets/{filename} references are supported.');
  }
}

function loadAssets(directory) {
  if (!directory) return [];
  let directoryStat;
  try {
    directoryStat = lstatSync(directory);
  } catch (error) {
    invalid(`Assets directory could not be read: ${error.message}`);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    invalid('Assets path must be a real directory, not a symlink.');
  }
  const assets = [];
  const seen = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) invalid(`Asset cannot be a symlink: ${entry.name}.`);
    if (!stat.isFile()) continue;
    const key = entry.name.toLowerCase();
    if (!SAFE_ASSET_NAME.test(entry.name) || entry.name.includes('/') || entry.name.includes('\\')) {
      invalid(`Invalid asset filename: ${entry.name}.`);
    }
    if (key.endsWith('.js') || key.endsWith('.mjs')) invalid(`JavaScript assets are not allowed: ${entry.name}.`);
    if (seen.has(key)) invalid(`Duplicate asset filename: ${entry.name}.`);
    seen.add(key);
    assets.push({ name: entry.name, mime: assetMime(entry.name), bytes: readFileSync(path) });
  }
  return assets;
}

export function loadPageUpload(kind, htmlPath, assetsDirectory = null) {
  if (!PAGE_KINDS.includes(kind)) invalid('Page kind must be instruction, benchmark, or showcase.');
  if (extname(htmlPath).toLowerCase() !== '.html') invalid('Page entry file must use the .html extension.');
  const htmlFile = readRegularFile(htmlPath, 'HTML file');
  const html = htmlFile.bytes.toString('utf8');
  if (html.includes('\uFFFD')) invalid('HTML file must be valid UTF-8.');
  validateHtml(html);
  const assets = loadAssets(assetsDirectory);
  const totalBytes = htmlFile.bytes.length + assets.reduce((sum, asset) => sum + asset.bytes.length, 0);
  if (totalBytes > MANAGE_UPLOAD_MAX_BYTES) {
    throw new ManageError('MANAGE_UPLOAD_TOO_LARGE', 'HTML and assets must total 4 MiB or less.', 3);
  }
  return {
    kind,
    field: kind,
    html: { name: basename(htmlPath), mime: 'text/html', bytes: htmlFile.bytes },
    assets,
    totalBytes,
  };
}
