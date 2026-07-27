import { CliError } from './utils.js';

export const MANAGE_INPUT_MAX_BYTES = 1024 * 1024;
export const SUPPORTED_AGENT_KEYS = Object.freeze([
  'claude-code',
  'openclaw',
  'codex-cli',
  'cursor-agent',
  'openhands',
  'gemini-cli',
]);

const TOP_LEVEL_FIELDS = new Set([
  'displayOverrides',
  'instructionOverrides',
  'supportedAgents',
  'relatedSkillSlugs',
]);
const DISPLAY_LIMITS = Object.freeze({
  category: 64,
  summary: 280,
  description: 4000,
  creatorStudioDescription: 2000,
  videoUrl: 2048,
});
const INSTRUCTION_FIELDS = new Set(['audience', 'runtime', 'examplePrompt', 'exampleOutput']);
const RUNTIME_FIELDS = new Set(['tools', 'permissions', 'apiKeys', 'environment', 'resources']);
const AUDIENCE_KEYS = new Set(['creator', 'researcher', 'builder', 'marketing']);
const TEXT_NULL_TO_EMPTY = new Set(['summary', 'description', 'creatorStudioDescription']);
const AGENT_KEYS = new Set(SUPPORTED_AGENT_KEYS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ManageError extends CliError {}

function invalid(message, details = {}) {
  throw new ManageError('MANAGE_INVALID', message, 3, details);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object.`);
}

function rejectUnknown(source, allowed, label) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) invalid(`Unknown ${label} field: ${key}.`);
  }
}

function assertNullableText(value, max, label) {
  if (value !== null && typeof value !== 'string') invalid(`${label} must be a string or null.`);
  if (typeof value === 'string' && value.length > max) invalid(`${label} must be ${max} characters or fewer.`);
}

function validateDisplayOverrides(value) {
  assertPlainObject(value, 'displayOverrides');
  rejectUnknown(value, new Set(Object.keys(DISPLAY_LIMITS)), 'displayOverrides');
  for (const [key, fieldValue] of Object.entries(value)) {
    assertNullableText(fieldValue, DISPLAY_LIMITS[key], `displayOverrides.${key}`);
  }
}

function validateRuntime(value) {
  if (value === null) return;
  assertPlainObject(value, 'instructionOverrides.runtime');
  rejectUnknown(value, RUNTIME_FIELDS, 'instructionOverrides.runtime');
  for (const [key, fieldValue] of Object.entries(value)) {
    assertNullableText(fieldValue, 160, `instructionOverrides.runtime.${key}`);
  }
}

function validateExampleOutput(value) {
  if (value === null) return;
  if (!Array.isArray(value)) invalid('instructionOverrides.exampleOutput must be an array or null.');
  if (value.length > 4) invalid('instructionOverrides.exampleOutput is limited to 4 rows.');
  for (const [index, row] of value.entries()) {
    assertPlainObject(row, `instructionOverrides.exampleOutput[${index}]`);
    rejectUnknown(row, new Set(['label', 'value']), `instructionOverrides.exampleOutput[${index}]`);
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 40) {
      invalid(`instructionOverrides.exampleOutput[${index}].label must be 1-40 characters.`);
    }
    if (typeof row.value !== 'string' || !row.value.trim() || row.value.length > 300) {
      invalid(`instructionOverrides.exampleOutput[${index}].value must be 1-300 characters.`);
    }
  }
}

function validateInstructionOverrides(value) {
  if (value === null) return;
  assertPlainObject(value, 'instructionOverrides');
  rejectUnknown(value, INSTRUCTION_FIELDS, 'instructionOverrides');
  if (Object.hasOwn(value, 'audience')) {
    if (value.audience !== null && !Array.isArray(value.audience)) {
      invalid('instructionOverrides.audience must be an array or null.');
    }
    if (Array.isArray(value.audience)) {
      const seen = new Set();
      for (const key of value.audience) {
        if (typeof key !== 'string' || !AUDIENCE_KEYS.has(key) || seen.has(key)) {
          invalid(`Unsupported or duplicate instruction audience: ${String(key)}.`);
        }
        seen.add(key);
      }
    }
  }
  if (Object.hasOwn(value, 'runtime')) validateRuntime(value.runtime);
  if (Object.hasOwn(value, 'examplePrompt')) {
    assertNullableText(value.examplePrompt, 600, 'instructionOverrides.examplePrompt');
  }
  if (Object.hasOwn(value, 'exampleOutput')) validateExampleOutput(value.exampleOutput);
}

function validateSupportedAgents(value) {
  if (!Array.isArray(value)) invalid('supportedAgents must be an array.');
  if (value.length > 24) invalid('supportedAgents is limited to 24 entries.');
  const seen = new Set();
  for (const [index, agent] of value.entries()) {
    assertPlainObject(agent, `supportedAgents[${index}]`);
    rejectUnknown(agent, new Set(['key', 'note']), `supportedAgents[${index}]`);
    if (typeof agent.key !== 'string' || !AGENT_KEYS.has(agent.key) || seen.has(agent.key)) {
      invalid(`Unsupported or duplicate supported agent: ${String(agent.key)}.`);
    }
    seen.add(agent.key);
    if (Object.hasOwn(agent, 'note')) assertNullableText(agent.note, 240, `supportedAgents[${index}].note`);
  }
}

function validateRelatedSkillSlugs(value) {
  if (!Array.isArray(value)) invalid('relatedSkillSlugs must be an array.');
  if (value.length > 4) invalid('relatedSkillSlugs is limited to 4 entries.');
  const seen = new Set();
  for (const slug of value) {
    if (typeof slug !== 'string' || !slug.trim() || slug.trim().length > 200) {
      invalid('Each related Skill slug must be a non-empty string of 200 characters or fewer.');
    }
    const clean = slug.trim();
    if (seen.has(clean)) invalid(`Duplicate related Skill slug: ${clean}.`);
    seen.add(clean);
  }
}

export function validateManageDocument(value) {
  assertPlainObject(value, 'Manage document');
  rejectUnknown(value, TOP_LEVEL_FIELDS, 'top-level');
  if (Object.hasOwn(value, 'displayOverrides')) validateDisplayOverrides(value.displayOverrides);
  if (Object.hasOwn(value, 'instructionOverrides')) validateInstructionOverrides(value.instructionOverrides);
  if (Object.hasOwn(value, 'supportedAgents')) validateSupportedAgents(value.supportedAgents);
  if (Object.hasOwn(value, 'relatedSkillSlugs')) validateRelatedSkillSlugs(value.relatedSkillSlugs);
  return value;
}

export function buildManagePatch(document, relatedSkillIds = []) {
  const patch = {};
  if (Object.hasOwn(document, 'displayOverrides')) {
    const displayOverrides = {};
    for (const [key, value] of Object.entries(document.displayOverrides)) {
      if (!Object.hasOwn(DISPLAY_LIMITS, key)) continue;
      displayOverrides[key] = value === null && TEXT_NULL_TO_EMPTY.has(key) ? '' : value;
    }
    patch.displayOverrides = displayOverrides;
  }
  if (Object.hasOwn(document, 'instructionOverrides')) patch.instructionOverrides = document.instructionOverrides;
  if (Object.hasOwn(document, 'supportedAgents')) {
    patch.supportedAgents = document.supportedAgents.map(agent => ({
      key: agent.key,
      ...(Object.hasOwn(agent, 'note') ? { note: agent.note } : {}),
    }));
  }
  if (Object.hasOwn(document, 'relatedSkillSlugs')) {
    if (!Array.isArray(relatedSkillIds) || relatedSkillIds.some(id => !UUID_RE.test(id))) {
      invalid('Related Skill resolution returned an invalid identifier.');
    }
    patch.relatedSkillIds = [...relatedSkillIds];
  }
  return patch;
}

export function buildEditableManageState(payload) {
  const skill = payload?.skill && typeof payload.skill === 'object' ? payload.skill : {};
  const display = skill.display_overrides && typeof skill.display_overrides === 'object'
    && !Array.isArray(skill.display_overrides) ? skill.display_overrides : {};
  const displayOverrides = Object.fromEntries(
    Object.keys(DISPLAY_LIMITS)
      .filter(key => Object.hasOwn(display, key))
      .map(key => [key, display[key]]),
  );
  const editable = {
    displayOverrides,
    instructionOverrides: skill.instruction_overrides && typeof skill.instruction_overrides === 'object'
      ? skill.instruction_overrides
      : {},
    supportedAgents: Array.isArray(payload?.supportedAgents)
      ? payload.supportedAgents.map(agent => ({
          key: agent.key,
          note: typeof agent.note === 'string' ? agent.note : '',
        }))
      : [],
    relatedSkillSlugs: Array.isArray(payload?.relatedSkills)
      ? payload.relatedSkills.map(skillRow => skillRow.slug).filter(Boolean)
      : [],
  };
  return { state: payload, editable };
}

function compareOrdered(requested, actual) {
  if (requested.length === actual.length && requested.every((value, index) => value === actual[index])) return null;
  const actualSet = new Set(actual);
  const requestedSet = new Set(requested);
  return {
    requested,
    actual,
    missing: requested.filter(value => !actualSet.has(value)),
    unexpected: actual.filter(value => !requestedSet.has(value)),
  };
}

export function verifyManagedCollections(document, payload) {
  const mismatches = [];
  if (Object.hasOwn(document, 'supportedAgents')) {
    const requested = document.supportedAgents.map(agent => agent.key);
    const actual = Array.isArray(payload?.supportedAgents) ? payload.supportedAgents.map(agent => agent.key) : [];
    const mismatch = compareOrdered(requested, actual);
    if (mismatch) mismatches.push({ field: 'supportedAgents', ...mismatch });
  }
  if (Object.hasOwn(document, 'relatedSkillSlugs')) {
    const requested = document.relatedSkillSlugs;
    const actual = Array.isArray(payload?.relatedSkills) ? payload.relatedSkills.map(skill => skill.slug) : [];
    const mismatch = compareOrdered(requested, actual);
    if (mismatch) mismatches.push({ field: 'relatedSkillSlugs', ...mismatch });
  }
  if (!mismatches.length) return null;
  const first = mismatches[0];
  return {
    code: 'MANAGE_VERIFICATION_FAILED',
    mutationApplied: true,
    requested: first.requested,
    actual: first.actual,
    missing: first.missing,
    unexpected: first.unexpected,
    mismatches,
  };
}
