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
  'informationOverrides',
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
const INFORMATION_FIELDS = new Set([
  'capabilities',
  'useCases',
  'audience',
  'releaseNotes',
  'testedModels',
  'requiresApiKey',
  'networkAccess',
  'pythonVersion',
  'nodeVersion',
  'purchaseBenefits',
]);
const INFORMATION_LIST_FIELDS = Object.freeze({
  capabilities: { maxItems: 8, maxLength: 240 },
  useCases: { maxItems: 8, maxLength: 240 },
  audience: { maxItems: 8, maxLength: 240 },
  testedModels: { maxItems: 8, maxLength: 240 },
});
const INFORMATION_TEXT_LIMITS = Object.freeze({
  releaseNotes: 2000,
  pythonVersion: 80,
  nodeVersion: 80,
  purchaseBenefits: 2000,
});
const INFORMATION_BOOLEAN_FIELDS = new Set(['requiresApiKey', 'networkAccess']);
const INSTRUCTION_FIELDS = new Set([
  'audience',
  'runtime',
  'prerequisites',
  'steps',
  'examplePrompt',
  'exampleOutput',
  'parameters',
  'troubleshooting',
  'knownLimitations',
]);
const INFORMATION_INSTRUCTION_CONTRACT_FIELDS = new Set([
  'prerequisites',
  'steps',
  'parameters',
  'troubleshooting',
  'knownLimitations',
]);
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

function validateStringList(value, label, maxItems, maxLength, allowDuplicates = false) {
  if (value === null) return;
  if (!Array.isArray(value)) invalid(`${label} must be an array or null.`);
  if (value.length > maxItems) invalid(`${label} is limited to ${maxItems} items.`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim() || item.length > maxLength) {
      invalid(`${label}[${index}] must be 1-${maxLength} characters.`);
    }
    const clean = item.trim();
    if (!allowDuplicates && seen.has(clean)) invalid(`${label} contains a duplicate item: ${clean}.`);
    seen.add(clean);
  }
}

function validateInformationOverrides(value) {
  if (value === null) return;
  assertPlainObject(value, 'informationOverrides');
  rejectUnknown(value, INFORMATION_FIELDS, 'informationOverrides');
  for (const [key, limits] of Object.entries(INFORMATION_LIST_FIELDS)) {
    if (Object.hasOwn(value, key)) {
      validateStringList(value[key], `informationOverrides.${key}`, limits.maxItems, limits.maxLength);
    }
  }
  for (const [key, max] of Object.entries(INFORMATION_TEXT_LIMITS)) {
    if (Object.hasOwn(value, key)) assertNullableText(value[key], max, `informationOverrides.${key}`);
  }
  for (const key of INFORMATION_BOOLEAN_FIELDS) {
    if (Object.hasOwn(value, key) && value[key] !== null && typeof value[key] !== 'boolean') {
      invalid(`informationOverrides.${key} must be true, false, or null.`);
    }
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
  if (value === null) invalid('instructionOverrides cannot be null.');
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
  if (Object.hasOwn(value, 'prerequisites')) {
    assertNullableText(value.prerequisites, 2000, 'instructionOverrides.prerequisites');
  }
  if (Object.hasOwn(value, 'steps')) {
    validateStringList(value.steps, 'instructionOverrides.steps', 12, 500, true);
  }
  if (Object.hasOwn(value, 'examplePrompt')) {
    assertNullableText(value.examplePrompt, 600, 'instructionOverrides.examplePrompt');
  }
  if (Object.hasOwn(value, 'exampleOutput')) validateExampleOutput(value.exampleOutput);
  if (Object.hasOwn(value, 'parameters')) {
    const parameters = value.parameters;
    if (parameters !== null && !Array.isArray(parameters)) {
      invalid('instructionOverrides.parameters must be an array or null.');
    }
    if (Array.isArray(parameters)) {
      if (parameters.length > 12) invalid('instructionOverrides.parameters is limited to 12 rows.');
      for (const [index, parameter] of parameters.entries()) {
        assertPlainObject(parameter, `instructionOverrides.parameters[${index}]`);
        rejectUnknown(parameter, new Set(['name', 'description']), `instructionOverrides.parameters[${index}]`);
        if (typeof parameter.name !== 'string' || !parameter.name.trim() || parameter.name.length > 80) {
          invalid(`instructionOverrides.parameters[${index}].name must be 1-80 characters.`);
        }
        if (typeof parameter.description !== 'string' || !parameter.description.trim()
          || parameter.description.length > 300) {
          invalid(`instructionOverrides.parameters[${index}].description must be 1-300 characters.`);
        }
      }
    }
  }
  for (const key of ['troubleshooting', 'knownLimitations']) {
    if (Object.hasOwn(value, key)) {
      validateStringList(value[key], `instructionOverrides.${key}`, 12, 500);
    }
  }
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
  if (Object.hasOwn(value, 'informationOverrides')) validateInformationOverrides(value.informationOverrides);
  if (Object.hasOwn(value, 'instructionOverrides')) validateInstructionOverrides(value.instructionOverrides);
  if (Object.hasOwn(value, 'supportedAgents')) validateSupportedAgents(value.supportedAgents);
  if (Object.hasOwn(value, 'relatedSkillSlugs')) validateRelatedSkillSlugs(value.relatedSkillSlugs);
  return value;
}

function normalizedText(value) {
  if (value === null) return null;
  const clean = value.trim();
  return clean || null;
}

function normalizedList(value) {
  if (value === null) return null;
  const items = value.map(item => item.trim()).filter(Boolean);
  return items.length ? items : null;
}

function normalizeInformationPatch(value) {
  if (value === null) return null;
  const next = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (Object.hasOwn(INFORMATION_LIST_FIELDS, key)) next[key] = normalizedList(fieldValue);
    else if (Object.hasOwn(INFORMATION_TEXT_LIMITS, key)) next[key] = normalizedText(fieldValue);
    else next[key] = fieldValue;
  }
  return next;
}

function normalizeInstructionPatch(value) {
  const next = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (key === 'runtime' && fieldValue && typeof fieldValue === 'object') {
      next.runtime = Object.fromEntries(Object.entries(fieldValue).map(([runtimeKey, runtimeValue]) => (
        [runtimeKey, normalizedText(runtimeValue)]
      )));
    } else if (['steps', 'troubleshooting', 'knownLimitations'].includes(key)) {
      next[key] = normalizedList(fieldValue);
    } else if (key === 'exampleOutput' && Array.isArray(fieldValue)) {
      next.exampleOutput = fieldValue.length ? fieldValue.map(row => ({
        label: row.label.trim(), value: row.value.trim(),
      })) : null;
    } else if (key === 'parameters' && Array.isArray(fieldValue)) {
      next.parameters = fieldValue.length ? fieldValue.map(row => ({
        name: row.name.trim(), description: row.description.trim(),
      })) : null;
    } else if (['prerequisites', 'examplePrompt'].includes(key)) {
      next[key] = normalizedText(fieldValue);
    } else {
      next[key] = fieldValue;
    }
  }
  return next;
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
  if (Object.hasOwn(document, 'informationOverrides')) {
    patch.informationOverrides = normalizeInformationPatch(document.informationOverrides);
  }
  if (Object.hasOwn(document, 'instructionOverrides')) {
    patch.instructionOverrides = normalizeInstructionPatch(document.instructionOverrides);
  }
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
  // `information_overrides` is also the capability marker for the split
  // Information/Instruction Manage contract. Omit it for older Site responses
  // so a get -> edit -> apply round trip does not pretend the field is supported.
  if (Object.hasOwn(skill, 'information_overrides')) {
    editable.informationOverrides = skill.information_overrides && typeof skill.information_overrides === 'object'
      && !Array.isArray(skill.information_overrides)
      ? skill.information_overrides
      : {};
  }
  return { state: payload, editable };
}

export function assertManageContractSupported(document, payload) {
  const instruction = document?.instructionOverrides;
  const usesSplitContract = Object.hasOwn(document ?? {}, 'informationOverrides')
    || (instruction && typeof instruction === 'object' && !Array.isArray(instruction)
      && Object.keys(instruction).some(key => INFORMATION_INSTRUCTION_CONTRACT_FIELDS.has(key)));
  if (!usesSplitContract) return;

  const skill = payload?.skill;
  if (skill && typeof skill === 'object' && Object.hasOwn(skill, 'information_overrides')) return;
  throw new ManageError(
    'MANAGE_CONTRACT_UNSUPPORTED',
    'The connected FinChip Site does not support Information/Instruction management. No update was sent.',
    3,
    { requiredContract: 'skill_information_instruction_v1', mutationApplied: false },
  );
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

function jsonValuesEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
}

function collectRequestedValueMismatches(expected, actual, path, mismatches) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      mismatches.push({ field: path, requested: expected, actual });
      return;
    }
    for (const key of Object.keys(expected)) {
      collectRequestedValueMismatches(expected[key], actual[key], `${path}.${key}`, mismatches);
    }
    return;
  }
  if (!jsonValuesEqual(expected, actual)) mismatches.push({ field: path, requested: expected, actual });
}

export function verifyManagedCollections(document, payload) {
  const mismatches = [];
  if (Object.hasOwn(document, 'informationOverrides')) {
    const requested = normalizeInformationPatch(document.informationOverrides);
    const actual = payload?.skill?.information_overrides;
    if (requested === null) {
      if (!jsonValuesEqual(actual, {})) mismatches.push({ field: 'informationOverrides', requested: {}, actual });
    } else {
      collectRequestedValueMismatches(requested, actual, 'informationOverrides', mismatches);
    }
  }
  if (Object.hasOwn(document, 'instructionOverrides')) {
    collectRequestedValueMismatches(
      normalizeInstructionPatch(document.instructionOverrides),
      payload?.skill?.instruction_overrides,
      'instructionOverrides',
      mismatches,
    );
  }
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
    missing: first.missing ?? [],
    unexpected: first.unexpected ?? [],
    mismatches,
  };
}
