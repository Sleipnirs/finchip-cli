import { getSymbol } from '../chains.js';
import { SkillDetailClient } from '../skill-detail.js';
import { emitFailure, emitResult, fmtChain, hd, inf, ok, sep } from '../utils.js';

function safetyText(safety) {
  const values = [];
  if (safety.certik.status) values.push(`CertiK ${safety.certik.status}`);
  if (safety.finchip.status) values.push(`FinChip ${safety.finchip.status}`);
  return values.length ? values.join(' · ') : 'not reviewed';
}

function ratingText(rating) {
  const average = rating.average ?? rating.rating ?? null;
  const count = rating.count ?? rating.reviewCount ?? null;
  if (average == null) return 'not rated';
  return count == null ? String(average) : `${average} (${count} reviews)`;
}

export async function cmdSkillShow(slug, options = {}, dependencies = {}) {
  try {
    const client = dependencies.client || new SkillDetailClient();
    const detail = await client.get(slug, options);
    const result = { ok: true, code: 'SKILL_PUBLIC_DETAIL', ...detail };
    emitResult(options, result, () => {
      hd('FinChip CLI — public Skill detail');
      sep();
      ok(`${detail.skill.title || '(untitled)'} (${detail.canonicalSlug})`);
      inf(detail.skill.summary || '(no summary)');
      inf(`author:   ${detail.skill.author || 'unknown'}`);
      inf(`category: ${detail.skill.category || 'unknown'}`);
      inf(`rating:   ${ratingText(detail.rating)}`);
      inf(`safety:   ${safetyText(detail.safety)}`);
      if (!detail.deployment.acquirable) {
        inf('deployment: no currently acquirable Web3 deployment');
        return;
      }
      inf(`chain:    ${fmtChain(detail.deployment.chainId)}`);
      inf(`price:    ${detail.deployment.price ?? 'unknown'} ${getSymbol(detail.deployment.chainId)}`);
      inf(`contract: ${detail.deployment.contractAddr}`);
      console.log('');
      inf(
        `Preflight: finchip acquire --slug ${detail.canonicalSlug}`
        + ` --chain ${detail.deployment.chainId}`
        + ` --addr ${detail.deployment.contractAddr} --dry-run`
      );
    });
  } catch (error) {
    emitFailure(options, error, {
      code: 'SKILL_DETAIL_FAILED',
      message: 'FinChip Skill detail failed.',
    });
  }
}
