// FinChip CLI v0.3.0 — A2A network-layer client
// ================================================
// Consumes the A2A protocol stack endpoints published at finchip.ai/.well-known/*
// and finchip.ai/openapi.json + /api/v1.
//
// Used by:
//   • finchip doctor       — sanity-checks every endpoint
//   • finchip protocol info — shows the full A2A endpoint surface
//   • finchip pay          — consumes /api/v1 x402 challenge
//   • finchip market list  — optionally enriches with DB-side skills.json
//   • prepare.js           — calls /api/get-key, /api/lit-encrypt, /api/register-chip

const DEFAULT_BASE = process.env.FINCHIP_API_URL || 'https://finchip.ai';

const TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(path, base = DEFAULT_BASE) {
  const url = base + path;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok && res.status !== 402) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json') && !ct.includes('linkset')) {
    // Some endpoints (e.g. http-message-signatures-directory) return jwk-set+json
    // which contains "json". Anything else is unexpected.
  }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.json(),
  };
}

async function fetchHead(path, base = DEFAULT_BASE) {
  const url = base + path;
  const res = await fetchWithTimeout(url, { method: 'HEAD' });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
  };
}

// ── Endpoint catalog (the 21 endpoints from A2A Protocol Stack V4) ──────────
export const A2A_ENDPOINTS = [
  // Discoverability
  { path: '/robots.txt',                                          group: 'Discoverability', critical: true  },
  { path: '/sitemap.xml',                                         group: 'Discoverability', critical: true  },
  // Content
  { path: '/.well-known/agent-card.json',                         group: 'Identity',        critical: true  },
  { path: '/.well-known/agent.json',                              group: 'Identity',        critical: false }, // legacy
  { path: '/.well-known/fc-key-config.json',                      group: 'Identity',        critical: true  },
  // Protocol
  { path: '/.well-known/mcp.json',                                group: 'Protocol',        critical: true  },
  { path: '/.well-known/acp.json',                                group: 'Protocol',        critical: true  },
  { path: '/.well-known/ucp',                                     group: 'Protocol',        critical: true  },
  { path: '/.well-known/mpp.json',                                group: 'Protocol',        critical: true  },
  { path: '/.well-known/api-catalog',                             group: 'Protocol',        critical: true  },
  { path: '/.well-known/api-catalog.json',                        group: 'Protocol',        critical: false }, // alt form
  { path: '/.well-known/skills.json',                             group: 'Catalog',         critical: true  },
  { path: '/.well-known/agent-skills/index.json',                 group: 'Catalog',         critical: true  },
  // Auth
  { path: '/.well-known/oauth-protected-resource',                group: 'Auth',            critical: true  },
  { path: '/.well-known/oauth-protected-resource.json',           group: 'Auth',            critical: false },
  { path: '/.well-known/oauth-authorization-server',              group: 'Auth',            critical: true  },
  { path: '/.well-known/oauth-authorization-server.json',         group: 'Auth',            critical: false },
  { path: '/.well-known/openid-configuration',                    group: 'Auth',            critical: true  },
  { path: '/.well-known/http-message-signatures-directory',       group: 'Auth',            critical: false },
  // Commerce
  { path: '/openapi.json',                                        group: 'Commerce',        critical: true  },
  { path: '/api/v1',                                              group: 'Commerce',        critical: true, expectStatus: 402 },
];

// ── Typed accessors ──────────────────────────────────────────────────────────
export async function fetchAgentCard(base)    { return fetchJson('/.well-known/agent-card.json', base); }
export async function fetchMcpCard(base)      { return fetchJson('/.well-known/mcp.json',        base); }
export async function fetchAcpCard(base)      { return fetchJson('/.well-known/acp.json',        base); }
export async function fetchUcpProfile(base)   { return fetchJson('/.well-known/ucp',             base); }
export async function fetchMppCard(base)      { return fetchJson('/.well-known/mpp.json',        base); }
export async function fetchFcKeyConfig(base)  { return fetchJson('/.well-known/fc-key-config.json', base); }
export async function fetchApiCatalog(base)   { return fetchJson('/.well-known/api-catalog',     base); }
export async function fetchSkillsJson(base)   { return fetchJson('/.well-known/skills.json',     base); }
export async function fetchOpenApi(base)      { return fetchJson('/openapi.json',                base); }
export async function fetchX402Challenge(base){ return fetchJson('/api/v1',                      base); }

/**
 * Ping every published A2A endpoint and report health.
 * Used by `finchip doctor`.
 */
export async function pingAllEndpoints(base = DEFAULT_BASE) {
  const results = [];
  for (const ep of A2A_ENDPOINTS) {
    try {
      const r = await fetchHead(ep.path, base);
      const expected = ep.expectStatus ?? 200;
      const ok = (r.status === expected) || (expected === 200 && r.status >= 200 && r.status < 300);
      results.push({ ...ep, status: r.status, contentType: r.contentType, ok });
    } catch (e) {
      results.push({ ...ep, status: 0, contentType: '', ok: false, error: e.message });
    }
  }
  return results;
}

// ── Internal FinChip API endpoints (used by prepare.js) ─────────────────────
export async function apiGetKey(payload, base = DEFAULT_BASE) {
  const res = await fetchWithTimeout(`${base}/api/get-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`get-key ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiLitEncrypt(payload, base = DEFAULT_BASE) {
  const res = await fetchWithTimeout(`${base}/api/lit-encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`lit-encrypt ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiRegisterChip(payload, base = DEFAULT_BASE) {
  const res = await fetchWithTimeout(`${base}/api/register-chip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : await res.text() };
}

export { DEFAULT_BASE };
