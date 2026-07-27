import { hashTypedData } from 'viem';

import { CHIP_ABI, CHIP_721_ABI, IFACE_ID } from './protocol.js';
import { CliError } from './utils.js';

export const CREATOR_ATTESTATION_TYPES = Object.freeze({
  CreatorAttestation: Object.freeze([
    Object.freeze({ name: 'chip', type: 'address' }),
    Object.freeze({ name: 'slug', type: 'string' }),
    Object.freeze({ name: 'contentHash', type: 'bytes32' }),
  ]),
});

export class AttestationError extends CliError {}

export function buildCreatorAttestation(chainId, chipAddress, slug, contentHash) {
  return {
    domain: {
      name: 'FinChipCreatorAttestation',
      version: '1',
      chainId,
      verifyingContract: chipAddress,
    },
    types: CREATOR_ATTESTATION_TYPES,
    primaryType: 'CreatorAttestation',
    message: { chip: chipAddress, slug, contentHash },
  };
}

function isUnsupportedContractError(error) {
  return /function selector|returned no data|does not exist|abi.*zero data|revert/i.test(
    `${error?.name || ''} ${error?.shortMessage || ''} ${error?.message || ''}`,
  );
}

function wallet(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

export async function resolveAttestationTokenType(publicClient, contractAddr, hint) {
  if (hint === 'erc1155' || hint === 'erc721') return hint;
  try {
    const isErc721 = await publicClient.readContract({
      address: contractAddr,
      abi: CHIP_ABI,
      functionName: 'supportsInterface',
      args: [IFACE_ID.ERC721],
    });
    return isErc721 ? 'erc721' : 'erc1155';
  } catch (error) {
    throw new AttestationError(
      'ATTESTATION_VERIFY_FAILED',
      error?.shortMessage || 'Could not determine the Chip token type.',
      5,
    );
  }
}

export async function executeCreatorAttestation(options) {
  const {
    chainId,
    contractAddr,
    tokenType,
    sessionWallet,
    account,
    publicClient,
    walletClient,
    dryRun = false,
    yes = false,
  } = options;
  if (!account?.address || wallet(sessionWallet) !== wallet(account.address)) {
    throw new AttestationError('WALLET_MISMATCH', 'Site login wallet and FINCHIP_PRIVATE_KEY wallet must match.', 3);
  }
  const abi = tokenType === 'erc721' ? CHIP_721_ABI : CHIP_ABI;

  let signatureSet;
  try {
    signatureSet = await publicClient.readContract({
      address: contractAddr,
      abi,
      functionName: 'creatorSignatureSet',
    });
  } catch (error) {
    if (isUnsupportedContractError(error)) {
      throw new AttestationError('ATTESTATION_UNSUPPORTED', 'This legacy Chip does not support Creator Attestation.', 3);
    }
    throw new AttestationError('ATTESTATION_VERIFY_FAILED', 'Could not read Creator Attestation status.', 5);
  }
  if (signatureSet) {
    let verified;
    try {
      verified = await publicClient.readContract({
        address: contractAddr,
        abi,
        functionName: 'isCreatorVerified',
      });
    } catch {
      throw new AttestationError('ATTESTATION_VERIFY_FAILED', 'Could not verify the existing Creator Attestation.', 5);
    }
    if (verified) {
      return {
        ok: true,
        code: 'CREATOR_ALREADY_VERIFIED',
        chainId,
        contractAddr,
        tokenType,
        txHash: null,
      };
    }
    throw new AttestationError(
      'ATTESTATION_VERIFY_FAILED',
      'The contract reports an existing Creator signature that does not verify.',
      5,
    );
  }

  let genesisCreator;
  let slug;
  let contentHash;
  let onChainDigest;
  try {
    [genesisCreator, slug, contentHash, onChainDigest] = await Promise.all([
      publicClient.readContract({ address: contractAddr, abi, functionName: 'genesisCreator' }),
      publicClient.readContract({ address: contractAddr, abi, functionName: 'slug' }),
      publicClient.readContract({ address: contractAddr, abi, functionName: 'contentHash' }),
      publicClient.readContract({ address: contractAddr, abi, functionName: 'creatorAttestationDigest' }),
    ]);
  } catch (error) {
    if (isUnsupportedContractError(error)) {
      throw new AttestationError('ATTESTATION_UNSUPPORTED', 'This legacy Chip does not support Creator Attestation.', 3);
    }
    throw new AttestationError('ATTESTATION_VERIFY_FAILED', 'Could not read Creator Attestation inputs.', 5);
  }
  if (wallet(genesisCreator) !== wallet(account.address)) {
    throw new AttestationError(
      'WALLET_MISMATCH',
      'Site login wallet, FINCHIP_PRIVATE_KEY wallet, and on-chain genesisCreator must match.',
      3,
    );
  }
  if (typeof slug !== 'string' || !slug || !/^0x[0-9a-fA-F]{64}$/.test(String(contentHash))) {
    throw new AttestationError('ATTESTATION_VERIFY_FAILED', 'The on-chain attestation inputs are malformed.', 5);
  }
  const payload = buildCreatorAttestation(chainId, contractAddr, slug, contentHash);
  const localDigest = hashTypedData(payload);
  if (localDigest.toLowerCase() !== String(onChainDigest).toLowerCase()) {
    throw new AttestationError(
      'ATTESTATION_DIGEST_MISMATCH',
      'Local EIP-712 digest does not match creatorAttestationDigest().',
      3,
    );
  }

  if (dryRun) {
    return {
      ok: true,
      code: 'ATTESTATION_DRY_RUN',
      slug,
      chainId,
      contractAddr,
      tokenType,
      genesisCreator,
      contentHash,
      digest: localDigest,
      txHash: null,
    };
  }
  if (!yes) {
    throw new AttestationError(
      'MANAGE_CONFIRM_REQUIRED',
      'Creator Attestation is an on-chain transaction with gas cost; pass --yes to continue.',
      3,
    );
  }
  if (!walletClient) {
    throw new AttestationError('ATTESTATION_TX_FAILED', 'Wallet client is unavailable.', 5);
  }

  let txHash;
  try {
    const signature = await walletClient.signTypedData({
      account,
      ...payload,
    });
    txHash = await walletClient.writeContract({
      address: contractAddr,
      abi,
      functionName: 'setCreatorSignature',
      args: [signature],
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 180_000,
      pollingInterval: 4_000,
    });
    if (receipt.status !== 'success') throw new Error('Creator Attestation transaction reverted.');
  } catch (error) {
    throw new AttestationError(
      'ATTESTATION_TX_FAILED',
      error?.shortMessage || error?.message || 'Creator Attestation transaction failed.',
      5,
      txHash ? { txHash } : {},
    );
  }

  let verified;
  try {
    verified = await publicClient.readContract({
      address: contractAddr,
      abi,
      functionName: 'isCreatorVerified',
    });
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new AttestationError(
      'ATTESTATION_VERIFY_FAILED',
      'The transaction was confirmed, but isCreatorVerified() is not true.',
      5,
      { txHash },
    );
  }
  return {
    ok: true,
    code: 'CREATOR_ATTESTATION_COMPLETE',
    slug,
    chainId,
    contractAddr,
    tokenType,
    txHash,
  };
}
