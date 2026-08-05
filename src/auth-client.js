import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { writePrivateTextFile } from './private-files.js';
import { FINCHIP_PROD_ORIGIN } from './site-origin.js';

const STORE_VERSION = 1;
const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.finchip', 'credentials.json');
const PERSISTED_COOKIES = new Set(['finchip_account_session', 'finchip_wallet_session']);
const AUTH_COOKIE_PREFIX = 'finchip_';
const DEFAULT_TIMEOUT_MS = 10_000;

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function normalizeApiOrigin(value = FINCHIP_PROD_ORIGIN) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('FinChip API origin must use http or https.');
  // Session cookies are bearer credentials: never send them over plaintext HTTP
  // except to a local test server.
  if (url.protocol === 'http:' && !LOCALHOST_HOSTNAMES.has(url.hostname)) {
    throw new Error('FinChip API origin must use HTTPS; HTTP is only allowed for dependency-injected local tests.');
  }
  return url.origin;
}

function credentialsPath(override) {
  return override || process.env.FINCHIP_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_PATH;
}

export function readCredentialStore(path = credentialsPath()) {
  if (!existsSync(path)) return { version: STORE_VERSION, profiles: {} };
  try {
    const store = JSON.parse(readFileSync(path, 'utf8'));
    return store?.version === STORE_VERSION && store.profiles && typeof store.profiles === 'object'
      ? store
      : { version: STORE_VERSION, profiles: {} };
  } catch {
    return { version: STORE_VERSION, profiles: {} };
  }
}

function writeCredentialStore(store, path) {
  writePrivateTextFile(path, `${JSON.stringify(store, null, 2)}\n`);
}

export function saveOriginCredentials(origin, cookies, options = {}) {
  const path = credentialsPath(options.path);
  const store = readCredentialStore(path);
  if (Object.keys(cookies).length) {
    store.profiles[origin] = { cookies, updatedAt: new Date(options.now ?? Date.now()).toISOString() };
  } else {
    delete store.profiles[origin];
  }
  writeCredentialStore(store, path);
}

export function loadOriginCredentials(origin, options = {}) {
  const path = credentialsPath(options.path);
  const profile = readCredentialStore(path).profiles[origin];
  if (!profile?.cookies || typeof profile.cookies !== 'object') return {};
  const now = options.now ?? Date.now();
  const cookies = Object.fromEntries(Object.entries(profile.cookies).filter(([, cookie]) =>
    cookie && typeof cookie.value === 'string' && (cookie.expiresAt == null || Number(cookie.expiresAt) > now)
  ));
  if (Object.keys(cookies).length !== Object.keys(profile.cookies).length) saveOriginCredentials(origin, cookies, { path });
  return cookies;
}

export class FinchipAuthError extends Error {
  constructor(code, message, exitCode = 5, details = {}) {
    super(message);
    this.name = 'FinchipAuthError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map(item => item.trim()).filter(Boolean);
}

export function getSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    return headers.getSetCookie().flatMap(splitSetCookieHeader);
  }
  return splitSetCookieHeader(headers?.get?.('set-cookie'));
}

export function parseSetCookie(value, now = Date.now()) {
  const parts = value.split(';').map(part => part.trim());
  const separator = parts[0]?.indexOf('=') ?? -1;
  if (separator <= 0) return null;
  const name = parts[0].slice(0, separator);
  const cookieValue = parts[0].slice(separator + 1);
  if (!name.startsWith(AUTH_COOKIE_PREFIX)) return null;

  let expiresAt = null;
  let remove = cookieValue === '';
  for (const attribute of parts.slice(1)) {
    const [rawKey, ...rawValue] = attribute.split('=');
    const key = rawKey.toLowerCase();
    const attributeValue = rawValue.join('=').trim();
    if (key === 'max-age') {
      const seconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(seconds)) {
        remove = seconds <= 0;
        expiresAt = now + seconds * 1000;
      }
    } else if (key === 'expires' && expiresAt == null) {
      const timestamp = Date.parse(attributeValue);
      if (Number.isFinite(timestamp)) {
        expiresAt = timestamp;
        if (timestamp <= now) remove = true;
      }
    }
  }
  return { name, value: cookieValue, expiresAt, remove };
}

export class FinchipAuthClient {
  constructor(options = {}) {
    this.origin = normalizeApiOrigin(options.origin);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.credentialsPath = options.credentialsPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.jar = new Map();
    const persisted = loadOriginCredentials(this.origin, { path: this.credentialsPath });
    for (const [name, cookie] of Object.entries(persisted)) this.jar.set(name, cookie);
  }

  hasPersistedCredentials() {
    return [...PERSISTED_COOKIES].some(name => this.jar.has(name));
  }

  clearCredentials() {
    for (const name of PERSISTED_COOKIES) this.jar.delete(name);
    saveOriginCredentials(this.origin, {}, { path: this.credentialsPath });
  }

  persistCredentials() {
    const cookies = {};
    for (const name of PERSISTED_COOKIES) {
      const cookie = this.jar.get(name);
      if (cookie) cookies[name] = cookie;
    }
    saveOriginCredentials(this.origin, cookies, { path: this.credentialsPath });
  }

  cookieHeader() {
    const now = Date.now();
    const values = [];
    for (const [name, cookie] of this.jar) {
      if (cookie.expiresAt != null && cookie.expiresAt <= now) {
        this.jar.delete(name);
        continue;
      }
      values.push(`${name}=${cookie.value}`);
    }
    return values.join('; ');
  }

  applySetCookies(response, { persist = true } = {}) {
    let persistedChanged = false;
    for (const header of getSetCookieHeaders(response.headers)) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      if (cookie.remove) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, { value: cookie.value, expiresAt: cookie.expiresAt });
      if (PERSISTED_COOKIES.has(cookie.name)) persistedChanged = true;
    }
    if (persist && persistedChanged) this.persistCredentials();
  }

  async request(path, options = {}) {
    const url = new URL(path, `${this.origin}/`);
    if (url.origin !== this.origin) {
      throw new FinchipAuthError('AUTH_NETWORK_ERROR', 'Authenticated requests must stay on the configured API origin.');
    }
    const { persistCookies, timeoutMs = this.timeoutMs, ...fetchOptions } = options;
    const method = (fetchOptions.method || 'GET').toUpperCase();
    const headers = new Headers(fetchOptions.headers || {});
    headers.set('Accept', headers.get('Accept') || 'application/json');
    const cookie = this.cookieHeader();
    if (cookie) headers.set('Cookie', cookie);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('Origin', this.origin);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...fetchOptions,
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw new FinchipAuthError(
        'AUTH_NETWORK_ERROR',
        error?.name === 'AbortError' ? 'FinChip authentication request timed out.' : 'Unable to reach the FinChip API.',
        5
      );
    } finally {
      clearTimeout(timer);
    }
    this.applySetCookies(response, { persist: persistCookies !== false });
    return response;
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }

  async getSession() {
    const { response, payload } = await this.json('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) {
      throw new FinchipAuthError('AUTH_NETWORK_ERROR', `Session request failed with status ${response.status}.`);
    }
    return payload;
  }

  async requireSession(options = {}) {
    const {
      walletRequired = false,
      missingMessage = 'Run `finchip login` first.',
      expiredMessage = 'FinChip session is expired.',
      details = {},
    } = options;
    if (!this.hasPersistedCredentials()) {
      throw new FinchipAuthError('AUTH_REQUIRED', missingMessage, 2, details);
    }
    const session = await this.getSession();
    if (!session.authenticated || (walletRequired && !session.wallet?.walletAddr)) {
      this.clearCredentials();
      throw new FinchipAuthError('AUTH_REQUIRED', expiredMessage, 2, details);
    }
    return session;
  }

  async authenticatedFetch(path, options = {}) {
    const response = await this.request(path, options);
    if (response.status !== 401) return response;
    const session = await this.getSession();
    if (!session.authenticated) this.clearCredentials();
    return response;
  }

  async authenticatedJson(path, options = {}) {
    const response = await this.authenticatedFetch(path, options);
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }
}
