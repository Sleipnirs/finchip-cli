import { readFileSync } from 'node:fs';

import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { resolveChain } from '../chains.js';
import {
  MANAGE_INPUT_MAX_BYTES,
  ManageError,
  buildEditableManageState,
  buildManagePatch,
  validateManageDocument,
  verifyManagedCollections,
} from '../manage-config.js';
import { emitFailure, emitResult, fmtAddr, fmtChain, hd, inf, ok, sep } from '../utils.js';

export function deploymentOptions(options) {
  if (Boolean(options.addr) !== Boolean(options.chain)) {
    throw new ManageError('SKILL_DEPLOYMENT_MISMATCH', '--addr and --chain must be provided together.', 3);
  }
  if (!options.addr) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.addr)) {
    throw new ManageError('SKILL_DEPLOYMENT_MISMATCH', 'Invalid contract address.', 3);
  }
  return { addr: options.addr.toLowerCase(), chainId: resolveChain(options.chain).id };
}

export function managePath(slug, deployment, extraQuery = null) {
  const query = new URLSearchParams();
  if (deployment) {
    query.set('addr', deployment.addr);
    query.set('chainId', String(deployment.chainId));
  }
  if (extraQuery) {
    for (const [key, value] of Object.entries(extraQuery)) query.set(key, value);
  }
  const suffix = query.size ? `?${query}` : '';
  return `/api/v2/skills/${encodeURIComponent(slug)}/manage${suffix}`;
}

export function mapManageHttpError(response, payload, fallback = 'Skill management request failed.') {
  const serverCode = typeof payload?.code === 'string' ? payload.code : '';
  const message = payload?.error || `${fallback} (${response.status}).`;
  if (response.status === 401) return new ManageError('AUTH_REQUIRED', 'Run `finchip login` first.', 2);
  if (response.status === 403) return new ManageError('NOT_CREATOR', message, 3);
  if (response.status === 404) return new ManageError('SKILL_NOT_FOUND', message, 3);
  if (response.status === 409 || serverCode === 'SLUG_ADDR_MISMATCH') {
    return new ManageError('SKILL_DEPLOYMENT_MISMATCH', message, 3);
  }
  if (response.status === 413) return new ManageError('MANAGE_UPLOAD_TOO_LARGE', message, 3);
  if (response.status >= 500) return new ManageError('MANAGE_SERVICE_UNAVAILABLE', message, 5);
  return new ManageError('MANAGE_INVALID', message, 3);
}

export async function authenticatedManageJson(client, path, options = {}) {
  try {
    return await client.authenticatedJson(path, options);
  } catch (error) {
    if (error instanceof FinchipAuthError) {
      if (error.code === 'AUTH_REQUIRED') throw error;
      throw new ManageError('MANAGE_SERVICE_UNAVAILABLE', error.message, 5);
    }
    throw error;
  }
}

export async function loadManageState(client, slug, deployment) {
  const first = await authenticatedManageJson(client, managePath(slug, deployment), {
    cache: 'no-store',
    timeoutMs: 30_000,
  });
  if (!first.response.ok) throw mapManageHttpError(first.response, first.payload);
  const canonicalSlug = typeof first.payload?.canonicalSlug === 'string' && first.payload.canonicalSlug.trim()
    ? first.payload.canonicalSlug.trim()
    : slug;
  if (canonicalSlug === slug && first.payload?.skill) {
    return { canonicalSlug, payload: first.payload };
  }
  const canonical = await authenticatedManageJson(client, managePath(canonicalSlug, deployment), {
    cache: 'no-store',
    timeoutMs: 30_000,
  });
  if (!canonical.response.ok) throw mapManageHttpError(canonical.response, canonical.payload);
  if (!canonical.payload?.skill) throw new ManageError('MANAGE_SERVICE_UNAVAILABLE', 'Skill management response is incomplete.', 5);
  return { canonicalSlug, payload: canonical.payload };
}

function readManageDocument(path) {
  let bytes;
  try {
    bytes = readFileSync(path === '-' ? 0 : path);
  } catch (error) {
    throw new ManageError('MANAGE_INVALID', `Could not read Manage input: ${error.message}`, 3);
  }
  if (bytes.length > MANAGE_INPUT_MAX_BYTES) {
    throw new ManageError('MANAGE_INVALID', 'Manage input must be 1 MiB or smaller.', 3);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManageError('MANAGE_INVALID', 'Manage input must be valid JSON.', 3);
  }
  return validateManageDocument(document);
}

async function resolveRelatedSkillIds(client, canonicalSlug, ownSkillId, slugs) {
  if (!slugs) return [];
  const ids = [];
  for (const requestedSlug of slugs) {
    if (requestedSlug === canonicalSlug) {
      throw new ManageError('MANAGE_INVALID', `A Skill cannot relate to itself: ${requestedSlug}.`, 3);
    }
    const { response, payload } = await authenticatedManageJson(
      client,
      managePath(canonicalSlug, null, { searchRelated: requestedSlug }),
      { cache: 'no-store', timeoutMs: 30_000 },
    );
    if (!response.ok) throw mapManageHttpError(response, payload, 'Related Skill lookup failed');
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    const exact = candidates.filter(candidate => candidate?.slug === requestedSlug && candidate?.id !== ownSkillId);
    if (exact.length !== 1) {
      const reason = exact.length === 0 ? 'was not found' : 'was ambiguous';
      throw new ManageError('MANAGE_INVALID', `Related Skill ${requestedSlug} ${reason}.`, 3);
    }
    ids.push(String(exact[0].id));
  }
  return ids;
}

function fail(options, error) {
  const normalized = error instanceof ManageError || error instanceof FinchipAuthError
    ? error
    : new ManageError('MANAGE_SERVICE_UNAVAILABLE', error instanceof Error ? error.message : 'Manage request failed.', 5);
  emitFailure(options, normalized, { code: 'MANAGE_SERVICE_UNAVAILABLE' });
}

function manageResult(code, canonicalSlug, deployment, payload) {
  const { state, editable } = buildEditableManageState(payload);
  return {
    ok: true,
    code,
    slug: canonicalSlug,
    chainId: deployment?.chainId ?? state.skill?.chain_id ?? null,
    contractAddr: deployment?.addr ?? state.skill?.chip_address ?? null,
    state,
    editable,
  };
}

export async function cmdSkillManageGet(slug, options = {}) {
  try {
    const deployment = deploymentOptions(options);
    const client = new FinchipAuthClient();
    await client.requireSession();
    const managed = await loadManageState(client, slug, deployment);
    const result = manageResult('SKILL_MANAGE_STATE', managed.canonicalSlug, deployment, managed.payload);
    emitResult(options, result, () => {
      hd('FinChip CLI — Skill manage');
      sep();
      ok(result.slug);
      inf(`chain:    ${result.chainId == null ? '(canonical)' : fmtChain(result.chainId)}`);
      inf(`contract: ${result.contractAddr ? fmtAddr(result.contractAddr) : '(canonical)'}`);
      inf(`agents:   ${result.editable.supportedAgents.length}`);
      inf(`related:  ${result.editable.relatedSkillSlugs.length}`);
    });
  } catch (error) {
    fail(options, error);
  }
}

export async function cmdSkillManageApply(slug, options = {}) {
  try {
    const document = readManageDocument(options.file);
    const deployment = deploymentOptions(options);
    const client = new FinchipAuthClient();
    await client.requireSession();
    const before = await loadManageState(client, slug, deployment);
    const relatedIds = await resolveRelatedSkillIds(
      client,
      before.canonicalSlug,
      before.payload.skill?.id,
      document.relatedSkillSlugs,
    );
    const patch = buildManagePatch(document, relatedIds);
    const body = {
      ...patch,
      ...(deployment ? { addr: deployment.addr, chainId: deployment.chainId } : {}),
    };
    if (options.dryRun) {
      const result = {
        ...manageResult('SKILL_MANAGE_DRY_RUN', before.canonicalSlug, deployment, before.payload),
        requested: document,
        patch,
      };
      emitResult(options, result, () => {
        hd('FinChip CLI — Skill manage dry run');
        sep();
        ok(`${result.slug} validated`);
        inf('No PATCH was sent.');
      });
      return;
    }

    const applied = await authenticatedManageJson(
      client,
      managePath(before.canonicalSlug, null),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      },
    );
    if (!applied.response.ok) throw mapManageHttpError(applied.response, applied.payload, 'Skill management update failed');

    let after;
    try {
      after = await loadManageState(client, before.canonicalSlug, deployment);
    } catch (error) {
      throw new ManageError(
        'MANAGE_RESULT_UNKNOWN',
        'The update was accepted, but its result could not be read back. Run `finchip skill manage get` to verify it.',
        5,
        { mutationApplied: true },
      );
    }
    const mismatch = verifyManagedCollections(document, after.payload);
    if (mismatch) {
      throw new ManageError(
        mismatch.code,
        'The Site did not persist the requested managed collections exactly.',
        5,
        mismatch,
      );
    }
    const result = manageResult('SKILL_MANAGE_UPDATED', after.canonicalSlug, deployment, after.payload);
    emitResult(options, result, () => {
      hd('FinChip CLI — Skill manage updated');
      sep();
      ok(result.slug);
      inf('The Site state was read back and verified.');
    });
  } catch (error) {
    fail(options, error);
  }
}
