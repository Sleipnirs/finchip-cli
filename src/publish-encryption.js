import { CliError } from './utils.js';
import { wrapFinchipV2ContentKey, wrapOracleV2ContentKey } from './publish-utils.js';

export const ENCRYPTION_MODES = Object.freeze({
  finchip: {
    marker: 'FINCHIP_V2',
    envelopeScheme: 'finchip-v2-base64-ck',
  },
  lit: {
    marker: 'LIT_V1',
    envelopeScheme: 'lit-v1-chipotle',
  },
  'oracle-v2': {
    marker: 'FINCHIP_V2_ORACLE',
    envelopeScheme: 'finchip-oracle-v2-raw-ck',
  },
});

function encryptionError(code, message, mode, exitCode = 5) {
  return new CliError(code, message, exitCode, {
    stage: 'key_setup',
    encryptionMode: mode,
  });
}

export function normalizeEncryptionMode(input, fallback = 'finchip') {
  const mode = String(input || fallback).trim().toLowerCase();
  if (!Object.hasOwn(ENCRYPTION_MODES, mode)) {
    throw new CliError(
      'PUBLISH_INVALID',
      '--encrypt must be one of: finchip, lit, oracle-v2.',
      3,
      { stage: 'validation', encryptionMode: mode || null },
    );
  }
  return mode;
}

export function assertEncryptionModeSupported(mode, chain) {
  if (mode === 'lit' && Number(chain.id) === 421614) {
    throw new CliError(
      'ENCRYPTION_MODE_UNSUPPORTED_ON_CHAIN',
      'Lit publishing is not available on Arbitrum Sepolia because the Site has no explicit mapping and the complete Chipotle publish/decrypt flow has not been verified there.',
      3,
      { stage: 'validation', encryptionMode: mode, chainId: chain.id },
    );
  }
}

function stateMismatch(message, mode, state) {
  return new CliError('PUBLISH_STATE_MISMATCH', message, 3, {
    stage: 'resume',
    encryptionMode: mode,
    resumable: true,
    resumeSlug: state.slug,
  });
}

export function normalizeResumeEncryptionState(state, explicitMode, chain) {
  const mode = normalizeEncryptionMode(state.mode || 'finchip');
  if (explicitMode && normalizeEncryptionMode(explicitMode) !== mode) {
    throw stateMismatch(
      `Saved publish mode is "${mode}", but --encrypt requested "${normalizeEncryptionMode(explicitMode)}".`,
      mode,
      state,
    );
  }
  const protocol = ENCRYPTION_MODES[mode];
  if (state.contentKeyFormat && state.contentKeyFormat !== 'raw-32-v1') {
    throw stateMismatch(`Saved content-key format "${state.contentKeyFormat}" is incompatible with ${mode}.`, mode, state);
  }
  if (state.envelopeScheme && state.envelopeScheme !== protocol.envelopeScheme) {
    throw stateMismatch(`Saved envelope scheme "${state.envelopeScheme}" is incompatible with ${mode}.`, mode, state);
  }
  if (state.marker && state.marker !== protocol.marker) {
    throw stateMismatch(`Saved marker "${state.marker}" is incompatible with ${mode}.`, mode, state);
  }
  if (state.preparedKeyData?.mode && state.preparedKeyData.mode !== mode) {
    throw stateMismatch('The prepared envelope mode does not match the saved publish mode.', mode, state);
  }
  if (state.preparedKeyData?.marker && state.preparedKeyData.marker !== protocol.marker) {
    throw stateMismatch('The prepared envelope marker does not match the saved publish mode.', mode, state);
  }
  if (
    state.version >= 2
    && ['key_prepared', 'key_submitted'].includes(state.stage)
    && (!state.preparedKeyData?.ciphertext || typeof state.preparedKeyData.ciphertext !== 'string')
  ) {
    throw stateMismatch('The saved prepared envelope is missing its ciphertext.', mode, state);
  }

  state.mode = mode;
  state.contentKeyFormat ||= 'raw-32-v1';
  state.envelopeScheme ||= protocol.envelopeScheme;
  state.marker ||= protocol.marker;
  state.diagnosticChainTag ||= chain.key;
  return state;
}

export function resumeNeedsContentKey(state) {
  return !['key_prepared', 'key_submitted', 'key_set'].includes(state.stage) && !state.setLitTxHash;
}

function mapServiceError(mode, status) {
  if (status === 503) {
    return encryptionError(
      'ENCRYPTION_SERVICE_UNAVAILABLE',
      `${mode === 'lit' ? 'Lit/Chipotle' : 'FinChip key'} service is not configured or temporarily unavailable.`,
      mode,
    );
  }
  if (status === 401 || status === 403) {
    const suffix = mode === 'oracle-v2'
      ? ' Oracle V2 key preparation requires the creator token0.'
      : '';
    return encryptionError(
      'ENCRYPTION_NOT_AUTHORIZED',
      `The Site did not authorize encryption key preparation.${suffix}`,
      mode,
      3,
    );
  }
  if (mode === 'lit' && status === 502) {
    return encryptionError(
      'ENCRYPTION_UPSTREAM_FAILED',
      'The Site could not obtain a Lit envelope from Chipotle.',
      mode,
    );
  }
  return encryptionError('KEY_SETUP_FAILED', `Encryption key preparation failed with HTTP ${status}.`, mode);
}

export async function prepareEncryptionEnvelope({
  mode,
  contentKey,
  chain,
  contractAddr,
  walletAddr,
  signMessage,
  request,
}) {
  const normalizedMode = normalizeEncryptionMode(mode);
  assertEncryptionModeSupported(normalizedMode, chain);
  const rawContentKey = Buffer.from(contentKey || []);
  if (rawContentKey.length !== 32) {
    throw encryptionError('KEY_SETUP_FAILED', 'Encryption requires a raw 32-byte content key.', normalizedMode);
  }

  const normalizedWallet = walletAddr.toLowerCase();
  const message = `FinChip key request\nchip: ${contractAddr}\nwallet: ${normalizedWallet}\nnonce: ${Date.now()}`;
  const signature = await signMessage(message);
  const body = {
    chipAddress: contractAddr,
    chainId: chain.id,
    walletAddress: normalizedWallet,
    signature,
    message,
  };
  let path = '/api/get-key';
  if (normalizedMode === 'lit') {
    path = '/api/lit-encrypt';
    body.aesKeyBase64 = rawContentKey.toString('base64');
  } else if (normalizedMode === 'oracle-v2') {
    body.version = 'v2';
  }

  const { response, payload } = await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw mapServiceError(normalizedMode, response.status);

  let ciphertext;
  try {
    if (normalizedMode === 'lit') {
      if (!payload.ciphertext || typeof payload.ciphertext !== 'string') {
        throw new Error('missing Lit ciphertext');
      }
      ciphertext = payload.ciphertext;
    } else {
      if (!payload.serverKey || typeof payload.serverKey !== 'string') {
        throw new Error('missing server key');
      }
      ciphertext = normalizedMode === 'oracle-v2'
        ? wrapOracleV2ContentKey(payload.serverKey, rawContentKey)
        : wrapFinchipV2ContentKey(payload.serverKey, rawContentKey);
    }
  } catch (error) {
    throw encryptionError(
      'KEY_SETUP_FAILED',
      error instanceof Error ? error.message : 'The encryption envelope is invalid.',
      normalizedMode,
    );
  }

  const protocol = ENCRYPTION_MODES[normalizedMode];
  return {
    ciphertext,
    marker: protocol.marker,
    chainTag: chain.key,
    mode: normalizedMode,
    contentKeyFormat: 'raw-32-v1',
    envelopeScheme: protocol.envelopeScheme,
  };
}

export function verifyEncryptionTuple(expected, onChainTuple) {
  const [ciphertext, marker, chainTag] = onChainTuple || [];
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw encryptionError('KEY_SETUP_FAILED', 'On-chain encryption ciphertext is empty.', expected.mode || 'finchip');
  }
  if (marker !== expected.marker) {
    throw encryptionError(
      'KEY_SETUP_FAILED',
      `On-chain encryption marker "${marker || ''}" does not match expected marker "${expected.marker}".`,
      expected.mode || 'finchip',
    );
  }
  if (expected.ciphertext && ciphertext !== expected.ciphertext) {
    throw encryptionError(
      'KEY_SETUP_FAILED',
      'On-chain encryption ciphertext does not match the saved prepared envelope.',
      expected.mode || 'finchip',
    );
  }

  const warnings = [];
  if (!expected.ciphertext) {
    warnings.push('Legacy publish state has no saved ciphertext; accepted the non-empty on-chain envelope after marker validation.');
  }
  if (expected.chainTag && chainTag !== expected.chainTag) {
    warnings.push(`On-chain encryption chain tag is "${chainTag || ''}"; saved diagnostic tag is "${expected.chainTag}".`);
  }
  return { warnings };
}
