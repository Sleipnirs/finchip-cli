import { decodeEventLog } from 'viem';
import { FACTORY_ABI } from './protocol.js';

function sameAddress(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

export function resolveDeployedChip({ receipt, factory, creator, slug }) {
  const candidates = [];
  for (const log of receipt?.logs || []) {
    if (!sameAddress(log.address, factory)) continue;
    try {
      const decoded = decodeEventLog({
        abi: FACTORY_ABI,
        eventName: 'ChipDeployedV2',
        data: log.data,
        topics: log.topics,
      });
      if (!decoded.args?.chipContract) continue;
      candidates.push({
        contractAddr: String(decoded.args.chipContract).toLowerCase(),
        creator: String(decoded.args.creator || '').toLowerCase(),
        slug: String(decoded.args.slug || ''),
      });
    } catch {
      // Other Factory events are expected in the same receipt.
    }
  }

  if (candidates.length === 0) {
    return {
      contractAddr: null,
      candidateCount: 0,
      warnings: ['No decodable ChipDeployedV2 event was found in the Factory receipt.'],
    };
  }

  if (candidates.length === 1) {
    const [candidate] = candidates;
    const warnings = [];
    if (!sameAddress(candidate.creator, creator)) {
      warnings.push(`Deployment event creator ${candidate.creator} did not match expected creator ${String(creator).toLowerCase()}.`);
    }
    if (candidate.slug !== slug) {
      warnings.push(`Deployment event slug ${candidate.slug} did not match expected slug ${slug}.`);
    }
    return { contractAddr: candidate.contractAddr, candidateCount: 1, warnings };
  }

  const exact = candidates.filter(candidate => (
    sameAddress(candidate.creator, creator) && candidate.slug === slug
  ));
  if (exact.length === 1) {
    return { contractAddr: exact[0].contractAddr, candidateCount: candidates.length, warnings: [] };
  }

  return {
    contractAddr: null,
    candidateCount: candidates.length,
    warnings: [`Factory receipt contains ${candidates.length} ambiguous ChipDeployedV2 events.`],
  };
}
