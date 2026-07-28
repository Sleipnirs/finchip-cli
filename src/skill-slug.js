export function canonicalSlug(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/(?:_|-)finchip$/, '');
  const clean = raw
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!clean) throw new Error('Slug is required.');
  return `${clean}_finchip`;
}

export function siteCanonicalSlug(value) {
  return canonicalSlug(value).replace(/_finchip$/, '-finchip');
}

export function siteLookupSlug(value) {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error('Slug is required.');
  return /(?:_|-)finchip$/i.test(requested)
    ? siteCanonicalSlug(requested)
    : requested;
}
