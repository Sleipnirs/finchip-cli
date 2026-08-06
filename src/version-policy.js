import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writePrivateTextFile } from './private-files.js';
import { FINCHIP_PROD_ORIGIN } from './site-origin.js';

export const CLI_VERSION_POLICY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CLI_VERSION_POLICY_FAILURE_TTL_MS = 60 * 60 * 1000;
export const CLI_VERSION_POLICY_TIMEOUT_MS = 1_200;

const POLICY_SCHEMA_VERSION = 1;
const UPDATE_COMMAND = 'npm install --global finchip-cli@latest';
const RELEASE_URL = 'https://github.com/Sleipnirs/finchip-cli/releases/latest';

function parseCliVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value));
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function compareCliVersions(left, right) {
  const a = parseCliVersion(left);
  const b = parseCliVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export function isCliVersionSupported(version, minimumVersion) {
  const current = parseCliVersion(version);
  const minimum = parseCliVersion(minimumVersion);
  if (!current || !minimum || current[0] !== minimum[0]) return false;
  const comparison = compareCliVersions(version, minimumVersion);
  return comparison !== null && comparison >= 0;
}

function normalizePolicy(value) {
  if (!value || value.schemaVersion !== POLICY_SCHEMA_VERSION) return null;
  const rangeComparison = compareCliVersions(value.minimumSupportedVersion, value.recommendedVersion);
  if (rangeComparison === null || rangeComparison > 0) return null;
  if (value.updateCommand !== UPDATE_COMMAND || value.releaseUrl !== RELEASE_URL) return null;
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    minimumSupportedVersion: value.minimumSupportedVersion,
    recommendedVersion: value.recommendedVersion,
    updateCommand: UPDATE_COMMAND,
    releaseUrl: RELEASE_URL,
  };
}

function loadCache(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.schemaVersion !== POLICY_SCHEMA_VERSION || !Number.isFinite(Date.parse(parsed.fetchedAt))) return null;
    return {
      fetchedAt: parsed.fetchedAt,
      policy: normalizePolicy(parsed.policy),
      refreshFailed: parsed.refreshFailed === true,
    };
  } catch {
    return null;
  }
}

function saveCache(path, fetchedAt, policy, refreshFailed) {
  try {
    writePrivateTextFile(path, `${JSON.stringify({ schemaVersion: POLICY_SCHEMA_VERSION, fetchedAt, refreshFailed, policy }, null, 2)}\n`);
  } catch {
    // Version-policy caching is advisory and must never fail the requested command.
  }
}

function warningFor(currentVersion, policy) {
  if (!policy) return null;
  const minimumComparison = compareCliVersions(currentVersion, policy.minimumSupportedVersion);
  const recommendedComparison = compareCliVersions(currentVersion, policy.recommendedVersion);
  if (minimumComparison === null || recommendedComparison === null || recommendedComparison >= 0) return null;
  return {
    code: minimumComparison < 0 ? 'CLI_UPDATE_REQUIRED' : 'CLI_UPDATE_AVAILABLE',
    severity: minimumComparison < 0 ? 'required' : 'recommended',
    currentVersion,
    minimumSupportedVersion: policy.minimumSupportedVersion,
    recommendedVersion: policy.recommendedVersion,
    updateCommand: policy.updateCommand,
    releaseUrl: policy.releaseUrl,
  };
}

async function fetchPolicy(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 8_192) return null;
    return normalizePolicy(JSON.parse(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkCliVersionPolicy({
  currentVersion,
  cachePath = join(homedir(), '.finchip', 'version-policy.json'),
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  policyUrl = `${FINCHIP_PROD_ORIGIN}/api/cli/version-policy`,
  timeoutMs = CLI_VERSION_POLICY_TIMEOUT_MS,
} = {}) {
  const cached = loadCache(cachePath);
  if (cached) {
    const age = Math.max(0, now - Date.parse(cached.fetchedAt));
    const ttl = cached.refreshFailed ? CLI_VERSION_POLICY_FAILURE_TTL_MS : CLI_VERSION_POLICY_CACHE_TTL_MS;
    if (age < ttl) return { source: 'cache', warning: warningFor(currentVersion, cached.policy) };
  }

  const policy = typeof fetchImpl === 'function' ? await fetchPolicy(fetchImpl, policyUrl, timeoutMs) : null;
  if (policy) {
    saveCache(cachePath, new Date(now).toISOString(), policy, false);
    return { source: 'network', warning: warningFor(currentVersion, policy) };
  }

  saveCache(cachePath, new Date(now).toISOString(), cached?.policy ?? null, true);
  if (cached?.policy) return { source: 'stale-cache', warning: warningFor(currentVersion, cached.policy) };
  return { source: 'unavailable', warning: null };
}

export function formatCliUpdateWarning(warning) {
  const label = warning.severity === 'required' ? 'Update required' : 'Update available';
  return `[FinChip] ${label}: installed ${warning.currentVersion}; recommended ${warning.recommendedVersion}. Run: ${warning.updateCommand}`;
}
