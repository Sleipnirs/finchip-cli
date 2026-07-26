export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_RANGE = '>=22.0.0';

export function isSupportedNodeVersion(version) {
  if (typeof version !== 'string' || version.length === 0) return false;
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  const majorText = normalized.split('.')[0];
  if (!/^\d+$/.test(majorText)) return false;
  const major = Number.parseInt(majorText, 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

export function buildUnsupportedNodeError(current) {
  return {
    ok: false,
    code: 'UNSUPPORTED_NODE_VERSION',
    required: MINIMUM_NODE_RANGE,
    current,
    message: `FinChip CLI requires Node.js ${MINIMUM_NODE_MAJOR} or newer.`,
  };
}
