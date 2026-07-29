import { getSymbol } from '../chains.js';
import { SkillSearchClient } from '../skill-search.js';
import { emitFailure, emitResult, fmtChain, hd, inf, ok, sep } from '../utils.js';

function formatMetric(value) {
  return value == null ? 'unknown' : String(value);
}

function formatPrice(deployment) {
  if (deployment.price == null) return 'unknown';
  return `${deployment.price} ${getSymbol(deployment.chainId)}`;
}

function formatSafety(safety) {
  const statuses = [];
  if (safety.certik.status) statuses.push(`CertiK ${safety.certik.status}`);
  if (safety.finchip.status) statuses.push(`FinChip ${safety.finchip.status}`);
  return statuses.length ? statuses.join(' · ') : 'not reviewed';
}

function renderCatalogResults(result, mode) {
  hd(mode === 'search' ? `FinChip Skill Search — ${result.query}` : 'FinChip Skill Catalog');
  sep();

  if (!result.skills.length) {
    inf(mode === 'search'
      ? 'No Web3 Skills matched this query.'
      : 'No Web3 Skills matched these filters.');
  } else {
    for (const skill of result.skills) {
      ok(`${skill.title || '(untitled)'} (${skill.slug || 'unknown slug'})`);
      inf(skill.summary || '(no summary)');
      inf(`author: ${skill.author || 'unknown'} · category: ${skill.category || 'unknown'}`);
      inf(`rating: ${formatMetric(skill.rating)} (${skill.reviewCount} reviews) · downloads: ${skill.downloads}`);
      inf(`chain: ${skill.deployment.chainId == null ? 'unknown' : fmtChain(skill.deployment.chainId)} · price: ${formatPrice(skill.deployment)}`);
      inf(`contract: ${skill.deployment.contractAddr || 'unknown'}`);
      inf(`safety: ${formatSafety(skill.safety)}`);
      if (skill.slug) inf(`show: finchip skill show ${skill.slug}`);
      if (skill.slug && skill.deployment.chainId != null && skill.deployment.contractAddr) {
        inf(
          `preflight: finchip acquire --slug ${skill.slug}`
          + ` --chain ${skill.deployment.chainId}`
          + ` --addr ${skill.deployment.contractAddr} --dry-run`
        );
      }
      console.log('');
    }
  }

  const total = result.pagination.total === 0 && result.skills.length > 0
    ? 'total unknown'
    : `total ${result.pagination.total}`;
  inf(`Returned ${result.skills.length} · offset ${result.pagination.offset} · ${total}`);
}

export async function cmdSkillSearch(query, options = {}, dependencies = {}) {
  try {
    const client = dependencies.client || new SkillSearchClient();
    const search = await client.search(query, options);
    const result = {
      ok: true,
      code: 'SKILL_SEARCH_RESULTS',
      ...search,
    };
    emitResult(options, result, () => renderCatalogResults(result, 'search'));
  } catch (error) {
    emitFailure(options, error, {
      code: 'SEARCH_FAILED',
      message: 'FinChip Skill search failed.',
    });
  }
}

export async function cmdSkillList(options = {}, dependencies = {}) {
  try {
    const client = dependencies.client || new SkillSearchClient();
    const listing = await client.list(options);
    const result = {
      ok: true,
      code: 'SKILL_LIST_RESULTS',
      ...listing,
    };
    emitResult(options, result, () => renderCatalogResults(result, 'list'));
  } catch (error) {
    emitFailure(options, error, {
      code: 'LIST_FAILED',
      message: 'FinChip Skill catalog listing failed.',
    });
  }
}
