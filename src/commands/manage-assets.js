import { FinchipAuthClient } from '../auth-client.js';
import { ManageError } from '../manage-config.js';
import { PAGE_KINDS, loadImageUpload, loadPageUpload } from '../manage-assets.js';
import { emitFailure, emitResult, hd, inf, ok, sep } from '../utils.js';
import {
  deploymentOptions,
  loadManageState,
  managePath,
  mapManageHttpError,
} from './manage.js';

const MANIFEST_FIELD = Object.freeze({
  instruction: 'instruction_manifest',
  benchmark: 'benchmark_manifest',
  showcase: 'showcase_manifest',
});

function fail(options, error) {
  const normalized = error instanceof ManageError
    ? error
    : new ManageError('MANAGE_SERVICE_UNAVAILABLE', error instanceof Error ? error.message : 'Manage upload failed.', 5);
  emitFailure(options, normalized, { code: 'MANAGE_SERVICE_UNAVAILABLE' });
}

function confirm(options, message) {
  if (!options.yes) throw new ManageError('MANAGE_CONFIRM_REQUIRED', message, 3);
}

async function context(slug, options) {
  const deployment = deploymentOptions(options);
  const client = new FinchipAuthClient();
  await client.requireSession();
  const managed = await loadManageState(client, slug, deployment);
  return { deployment, client, ...managed };
}

function appendDeployment(form, deployment) {
  if (!deployment) return;
  form.append('addr', deployment.addr);
  form.append('chainId', String(deployment.chainId));
}

function appendFile(form, field, file) {
  form.append(field, new Blob([file.bytes], { type: file.mime }), file.name);
}

async function mutationJson(client, path, options) {
  try {
    const response = await client.authenticatedFetch(path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw mapManageHttpError(response, payload, 'Manage upload failed');
    return payload;
  } catch (error) {
    if (error instanceof ManageError) throw error;
    throw new ManageError(
      'MANAGE_UPLOAD_RESULT_UNKNOWN',
      'The upload connection ended without a confirmed result. Run `finchip skill manage get` before retrying.',
      5,
      { mutationApplied: null },
    );
  }
}

export async function cmdSkillManageImageSet(slug, options = {}) {
  try {
    const image = loadImageUpload(options.file);
    const managed = await context(slug, options);
    const existing = managed.payload.skill?.display_overrides?.imagePath || null;
    if (!options.dryRun && existing) {
      confirm(options, 'Replacing the current Skill image requires --yes.');
    }
    if (options.dryRun) {
      const result = {
        ok: true,
        code: 'SKILL_IMAGE_DRY_RUN',
        slug: managed.canonicalSlug,
        file: image.name,
        mime: image.mime,
        bytes: image.bytes.length,
        replacing: Boolean(existing),
      };
      emitResult(options, result, () => {
        hd('FinChip CLI — image dry run'); sep(); ok(`${result.file} validated`);
        inf(result.replacing ? 'The current image would be replaced.' : 'This would be the first image.');
      });
      return;
    }
    const form = new FormData();
    appendFile(form, 'image', image);
    appendDeployment(form, managed.deployment);
    const payload = await mutationJson(
      managed.client,
      `/api/v2/skills/${encodeURIComponent(managed.canonicalSlug)}/manage/image`,
      { method: 'POST', body: form, timeoutMs: 60_000 },
    );
    const result = {
      ok: true,
      code: 'SKILL_IMAGE_UPDATED',
      slug: managed.canonicalSlug,
      imagePath: payload.imagePath || null,
      replacing: Boolean(existing),
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — image updated'); sep(); ok(result.slug);
      inf(`imagePath: ${result.imagePath || '(Site did not return a path)'}`);
    });
  } catch (error) {
    fail(options, error);
  }
}

export async function cmdSkillManagePageUpload(slug, options = {}) {
  try {
    const page = loadPageUpload(options.kind, options.html, options.assetsDir);
    const managed = await context(slug, options);
    const existing = managed.payload.skill?.[MANIFEST_FIELD[page.kind]] || null;
    if (!options.dryRun && existing) {
      confirm(options, `Replacing the current ${page.kind} page requires --yes.`);
    }
    if (options.dryRun) {
      const result = {
        ok: true,
        code: 'SKILL_PAGE_DRY_RUN',
        slug: managed.canonicalSlug,
        kind: page.kind,
        html: page.html.name,
        assetCount: page.assets.length,
        bytes: page.totalBytes,
        replacing: Boolean(existing),
      };
      emitResult(options, result, () => {
        hd('FinChip CLI — page dry run'); sep(); ok(`${page.kind} package validated`);
        inf(`assets: ${page.assets.length}`);
        inf(`bytes:  ${page.totalBytes}`);
      });
      return;
    }
    const form = new FormData();
    appendFile(form, page.field, page.html);
    for (const asset of page.assets) appendFile(form, 'assets', asset);
    appendDeployment(form, managed.deployment);
    const payload = await mutationJson(
      managed.client,
      `/api/v2/skills/${encodeURIComponent(managed.canonicalSlug)}/manage/${page.kind}`,
      { method: 'POST', body: form, timeoutMs: 60_000 },
    );
    const result = {
      ok: true,
      code: 'SKILL_PAGE_UPLOADED',
      slug: managed.canonicalSlug,
      kind: page.kind,
      manifest: payload.manifest || null,
      assetCount: page.assets.length,
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — page uploaded'); sep(); ok(`${result.slug} ${result.kind}`);
      inf(`assets: ${result.assetCount}`);
    });
  } catch (error) {
    fail(options, error);
  }
}

export async function cmdSkillManagePageRestore(slug, options = {}) {
  try {
    if (!PAGE_KINDS.includes(options.kind)) {
      throw new ManageError('MANAGE_INVALID', 'Page kind must be instruction, benchmark, or showcase.', 3);
    }
    const managed = await context(slug, options);
    const existing = managed.payload.skill?.[MANIFEST_FIELD[options.kind]] || null;
    if (options.dryRun) {
      const result = {
        ok: true,
        code: 'SKILL_PAGE_RESTORE_DRY_RUN',
        slug: managed.canonicalSlug,
        kind: options.kind,
        hasCustomPage: Boolean(existing),
      };
      emitResult(options, result, () => {
        hd('FinChip CLI — page restore dry run'); sep(); ok(`${result.slug} ${result.kind}`);
        inf(result.hasCustomPage ? 'The custom page would be removed.' : 'The default page is already active.');
      });
      return;
    }
    confirm(options, `Restoring the default ${options.kind} page requires --yes.`);
    const body = managed.deployment
      ? { addr: managed.deployment.addr, chainId: managed.deployment.chainId }
      : {};
    await mutationJson(
      managed.client,
      `/api/v2/skills/${encodeURIComponent(managed.canonicalSlug)}/manage/${options.kind}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      },
    );
    const result = {
      ok: true,
      code: 'SKILL_PAGE_RESTORED',
      slug: managed.canonicalSlug,
      kind: options.kind,
      manifest: null,
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — page restored'); sep(); ok(`${result.slug} ${result.kind}`);
    });
  } catch (error) {
    fail(options, error);
  }
}
