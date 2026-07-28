import { privateKeyToAccount } from 'viem/accounts';

import { listChains, resolveChain } from '../chains.js';
import { getPublicClient } from '../client.js';
import { loadConfig, resolveWalletPrivateKey } from '../config.js';
import {
  LibraryCatalogClient,
  LibraryError,
  scanLibrary,
} from '../library-scan.js';
import {
  c,
  err,
  emitFailure,
  emitResult,
  fmtAddr,
  fmtWei,
  hd,
  inf,
  ok,
  sep,
  wrn,
} from '../utils.js';

export function chainsForFilter(chainInput) {
  return chainInput ? [resolveChain(chainInput)] : listChains();
}

function priceText(holding) {
  return holding.priceWei == null
    ? 'unknown'
    : fmtWei(BigInt(holding.priceWei), holding.chainId);
}

function quantityText(holding) {
  if (holding.tokenStandard === 'ERC-721') return holding.balance;
  return `t0:${holding.creatorBalance ?? '?'} t1:${holding.licenseBalance}`;
}

function renderLibrary(result) {
  hd(`FinChip Library — ${fmtAddr(result.wallet)}`);
  sep();
  inf(`wallet:  ${result.wallet}`);
  inf(`catalog: Site active Chip directory (${result.catalog.candidates} candidates)`);
  console.log('');

  for (const chain of result.chains) {
    console.log(`${c.bold}${chain.chainName} (${chain.chainId})${c.reset}`);
    inf(`snapshot: ${chain.snapshotBlock ?? 'not required'} · candidates: ${chain.candidates}`);
    const holdings = result.holdings.filter(holding => holding.chainId === chain.chainId);
    if (!holdings.length) {
      console.log(`  ${c.gray}— no confirmed holdings on this chain${c.reset}\n`);
      continue;
    }
    for (const holding of holdings) {
      console.log(`  ${c.cyan}${holding.slug}${c.reset}`);
      inf(`${holding.tokenStandard} · ${holding.role} · ${quantityText(holding)}`);
      inf(`${fmtAddr(holding.contractAddr)} · ${priceText(holding)}`);
    }
    console.log('');
  }

  sep();
  if (!result.complete) {
    wrn(
      `Partial result: ${result.totals.failed} balance scan(s) and `
      + `${result.totals.metadataFailed} authoritative metadata read(s) were incomplete.`,
    );
    for (const warning of result.warnings.slice(0, 10)) {
      inf(
        `[${warning.code}] chain ${warning.chainId}`
        + `${warning.contractAddr ? ` · ${fmtAddr(warning.contractAddr)}` : ''}: ${warning.message}`,
      );
    }
    if (result.warnings.length > 10) {
      inf(`${result.warnings.length - 10} additional warning(s); use --json for full details.`);
    }
  }
  ok(
    `Total: ${result.totals.erc1155LicenseBalance} ERC-1155 license(s), `
    + `${result.totals.erc1155CreatorBalance} creator token(s), `
    + `${result.totals.erc721Balance} ERC-721 fork(s)`,
  );
  console.log('');
}

export async function cmdLibrary(options = {}, dependencies = {}) {
  try {
    const cfg = dependencies.config || loadConfig();
    let walletAddress = options.wallet || cfg.wallet;
    if (!walletAddress) {
      const privateKey = (dependencies.resolveWalletPrivateKey || resolveWalletPrivateKey)(cfg);
      walletAddress = privateKeyToAccount(privateKey).address;
    }

    let chains;
    try {
      chains = chainsForFilter(options.chain);
    } catch (error) {
      throw new LibraryError('LIBRARY_INVALID', error.message, 3);
    }
    const catalogClient = dependencies.catalogClient || new LibraryCatalogClient();
    const publicClientFactory = dependencies.publicClientFactory
      || (chainId => getPublicClient(chainId, cfg.rpc));
    const result = await scanLibrary({
      walletAddress,
      chains,
      catalogClient,
      publicClientFactory,
    });
    emitResult(options, result, () => renderLibrary(result));
    return result;
  } catch (error) {
    if (options.json) {
      emitFailure(options, error, {
        code: 'LIBRARY_SERVICE_UNAVAILABLE',
        message: 'FinChip Library lookup failed.',
      });
    } else {
      const code = error?.code || 'LIBRARY_SERVICE_UNAVAILABLE';
      err(`[${code}] ${error?.message || 'FinChip Library lookup failed.'}`);
      process.exitCode = error?.exitCode || 5;
    }
    return null;
  }
}
