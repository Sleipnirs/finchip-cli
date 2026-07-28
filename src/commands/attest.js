import { privateKeyToAccount } from 'viem/accounts';

import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { loadConfig, resolveWalletPrivateKey, WalletKeyError } from '../config.js';
import {
  AttestationError,
  executeCreatorAttestation,
  resolveAttestationTokenType,
} from '../creator-attestation.js';
import { ManageError } from '../manage-config.js';
import { emitFailure, emitResult, fmtAddr, fmtChain, hd, inf, ok, sep } from '../utils.js';
import { deploymentOptions, loadManageState } from './manage.js';

function fail(options, error) {
  const normalized = error instanceof AttestationError
    || error instanceof ManageError
    || error instanceof FinchipAuthError
    || error instanceof WalletKeyError
    ? error
    : new AttestationError(
        'ATTESTATION_VERIFY_FAILED',
        error instanceof Error ? error.message : 'Creator Attestation failed.',
        5,
      );
  emitFailure(options, normalized, { code: 'ATTESTATION_VERIFY_FAILED' });
}

function sessionWallet(session) {
  return session?.wallet?.walletAddr || session?.identity?.walletAddr || null;
}

export async function cmdSkillManageAttest(slug, options = {}) {
  try {
    const deployment = deploymentOptions(options);
    if (!deployment) {
      throw new ManageError(
        'SKILL_DEPLOYMENT_MISMATCH',
        'Creator Attestation requires both --chain and --addr.',
        3,
      );
    }
    const cfg = loadConfig();
    const privateKey = resolveWalletPrivateKey(cfg);
    const account = privateKeyToAccount(privateKey);
    const client = new FinchipAuthClient();
    const session = await client.requireSession({ walletRequired: true });
    const loggedInWallet = sessionWallet(session);
    if (!loggedInWallet || loggedInWallet.toLowerCase() !== account.address.toLowerCase()) {
      throw new AttestationError(
        'WALLET_MISMATCH',
        'Site login wallet and configured Agent wallet must match.',
        3,
      );
    }
    const managed = await loadManageState(client, slug, deployment);
    const skill = managed.payload.skill || {};
    if (
      skill.chip_address
      && String(skill.chip_address).toLowerCase() !== deployment.addr
    ) {
      throw new ManageError('SKILL_DEPLOYMENT_MISMATCH', 'Site deployment address does not match --addr.', 3);
    }
    if (
      skill.chain_id != null
      && Number(skill.chain_id) !== deployment.chainId
    ) {
      throw new ManageError('SKILL_DEPLOYMENT_MISMATCH', 'Site deployment chain does not match --chain.', 3);
    }
    const publicClient = getPublicClient(deployment.chainId, cfg.rpc);
    const tokenType = await resolveAttestationTokenType(
      publicClient,
      deployment.addr,
      skill.token_type,
    );
    const walletClient = options.dryRun
      ? null
      : getWalletClient(deployment.chainId, privateKey, cfg.rpc).client;
    const result = await executeCreatorAttestation({
      chainId: deployment.chainId,
      contractAddr: deployment.addr,
      tokenType,
      sessionWallet: loggedInWallet,
      account,
      publicClient,
      walletClient,
      dryRun: options.dryRun === true,
      yes: options.yes === true,
    });
    const output = { ...result, siteSlug: managed.canonicalSlug };
    emitResult(options, output, () => {
      hd('FinChip CLI — Creator Attestation');
      sep();
      ok(output.code === 'CREATOR_ALREADY_VERIFIED' ? 'Creator already verified' : output.siteSlug);
      inf(`chain:    ${fmtChain(output.chainId)}`);
      inf(`contract: ${fmtAddr(output.contractAddr)}`);
      inf(`type:     ${output.tokenType}`);
      if (output.code === 'ATTESTATION_DRY_RUN') inf('Digest matches; no signature or transaction was produced.');
      if (output.txHash) inf(`tx:       ${output.txHash}`);
    });
  } catch (error) {
    fail(options, error);
  }
}
