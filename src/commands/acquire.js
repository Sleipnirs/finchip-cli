import { formatEther, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, resolveConfiguredPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { resolveChain } from '../chains.js';
import { CHIP_ABI, CHIP_721_ABI, IFACE_ID } from '../protocol.js';
import { SkillDetailClient } from '../skill-detail.js';
import {
  CliError,
  emitFailure,
  emitResult,
  fmtChain,
  fmtTxLink,
  fmtWei,
  hd,
  inf,
  ok,
  sep,
} from '../utils.js';

const TX_TIMEOUT_MS = 180_000;
const GAS_BUFFER_DIVISOR = 5n;

class AcquireError extends CliError {
  constructor(code, message, exitCode = 5, details = {}) {
    super(code, message, exitCode, details);
    this.name = 'AcquireError';
  }
}

const DEFAULT_DEPENDENCIES = {
  detailClient: null,
  loadConfig,
  resolvePrivateKey: resolveConfiguredPrivateKey,
  accountFromPrivateKey: privateKeyToAccount,
  publicClientFactory: getPublicClient,
  walletClientFactory: getWalletClient,
};

function validateOptions(options) {
  if (!String(options.slug || '').trim()) {
    throw new AcquireError('ACQUIRE_INVALID', '--slug is required.', 3);
  }
  if (options.dryRun && options.yes) {
    throw new AcquireError('ACQUIRE_INVALID', '--dry-run and --yes cannot be used together.', 3);
  }
  if (Boolean(options.chain) !== Boolean(options.addr)) {
    throw new AcquireError('ACQUIRE_INVALID', '--chain and --addr must be provided together.', 3);
  }
  if (options.addr && !isAddress(options.addr, { strict: false })) {
    throw new AcquireError('ACQUIRE_INVALID', 'Invalid deployment contract address.', 3);
  }
  if (options.chain) {
    try {
      resolveChain(options.chain);
    } catch {
      throw new AcquireError('ACQUIRE_INVALID', `Unsupported deployment chain: ${options.chain}.`, 3);
    }
  }
}

function mapDetailError(error) {
  if (error?.code === 'SKILL_SHOW_INVALID') {
    return new AcquireError('ACQUIRE_INVALID', error.message, 3, error.details);
  }
  if (error?.code === 'SKILL_DETAIL_UNAVAILABLE' || error?.code === 'SKILL_DETAIL_FAILED') {
    return new AcquireError(
      'SKILL_NOT_ACQUIRABLE',
      'Unable to establish an exact acquirable deployment from FinChip.',
      5
    );
  }
  return error;
}

async function resolveDeployment(options, dependencies) {
  const client = dependencies.detailClient || new SkillDetailClient();
  let detail;
  try {
    detail = await client.get(options.slug, {
      chain: options.chain,
      addr: options.addr,
    });
  } catch (error) {
    throw mapDetailError(error);
  }
  if (!detail?.deployment?.acquirable) {
    throw new AcquireError(
      'SKILL_NOT_ACQUIRABLE',
      'This Skill has no currently acquirable Web3 deployment.',
      3
    );
  }
  if (
    !Number.isInteger(detail.deployment.chainId)
    || !isAddress(detail.deployment.contractAddr || '', { strict: false })
  ) {
    throw new AcquireError(
      'SKILL_DEPLOYMENT_MISMATCH',
      'FinChip returned an invalid Skill deployment.',
      3
    );
  }
  let chain;
  try {
    chain = resolveChain(detail.deployment.chainId);
  } catch {
    throw new AcquireError(
      'SKILL_DEPLOYMENT_MISMATCH',
      `FinChip returned unsupported chain ${detail.deployment.chainId}.`,
      3
    );
  }
  return {
    slug: detail.canonicalSlug,
    chain,
    contractAddr: detail.deployment.contractAddr,
  };
}

async function getterWorks(publicClient, contractAddr, abi, functionName) {
  try {
    await publicClient.readContract({ address: contractAddr, abi, functionName });
    return true;
  } catch {
    return false;
  }
}

async function resolveTokenStandard(publicClient, contractAddr, forceFork) {
  if (forceFork) {
    if (await getterWorks(publicClient, contractAddr, CHIP_721_ABI, 'forkPrice')) return 'ERC-721';
    throw new AcquireError(
      'ACQUIRE_STANDARD_UNSUPPORTED',
      '--fork was specified, but the deployment does not expose the ERC-721 fork interface.',
      3
    );
  }

  try {
    const is721 = await publicClient.readContract({
      address: contractAddr,
      abi: CHIP_721_ABI,
      functionName: 'supportsInterface',
      args: [IFACE_ID.ERC721],
    });
    if (is721 === true) {
      if (await getterWorks(publicClient, contractAddr, CHIP_721_ABI, 'forkPrice')) return 'ERC-721';
      throw new AcquireError(
        'ACQUIRE_STANDARD_UNSUPPORTED',
        'The deployment advertises ERC-721 but does not expose the FinChip fork purchase interface.',
        3
      );
    }
  } catch {
    // Legacy deployments may not implement ERC-165. Probe both exact price
    // getters below and accept only a unique result.
  }

  const [is1155, is721] = await Promise.all([
    getterWorks(publicClient, contractAddr, CHIP_ABI, 'licensePrice'),
    getterWorks(publicClient, contractAddr, CHIP_721_ABI, 'forkPrice'),
  ]);
  if (is1155 && !is721) return 'ERC-1155';
  if (is721 && !is1155) return 'ERC-721';
  throw new AcquireError(
    'ACQUIRE_STANDARD_UNSUPPORTED',
    'Could not uniquely determine whether this deployment is ERC-1155 or ERC-721.',
    3
  );
}

function contractPlan(tokenStandard) {
  return tokenStandard === 'ERC-721'
    ? {
        abi: CHIP_721_ABI,
        priceFn: 'forkPrice',
        issuedFn: 'totalForked',
        capacityFn: 'maxForks',
        purchaseMethod: 'purchaseFork',
        balanceArgs: address => [address],
      }
    : {
        abi: CHIP_ABI,
        priceFn: 'licensePrice',
        issuedFn: 'totalMinted',
        capacityFn: 'maxSupply',
        purchaseMethod: 'purchaseLicense',
        balanceArgs: address => [address, 1n],
      };
}

function failureDetails(result, extra = {}) {
  const { ok: _ok, code: _code, ...details } = result;
  return { ...details, ...extra };
}

async function preflight(publicClient, deployment, account, tokenStandard, options = {}) {
  const plan = contractPlan(tokenStandard);
  const base = {
    slug: deployment.slug,
    chainId: deployment.chain.id,
    contractAddr: deployment.contractAddr,
  };
  let price;
  let issued;
  let capacity;
  let heldBefore;
  let walletBalance;
  try {
    [price, issued, capacity, heldBefore, walletBalance] = await Promise.all([
      publicClient.readContract({
        address: deployment.contractAddr,
        abi: plan.abi,
        functionName: plan.priceFn,
      }),
      publicClient.readContract({
        address: deployment.contractAddr,
        abi: plan.abi,
        functionName: plan.issuedFn,
      }),
      publicClient.readContract({
        address: deployment.contractAddr,
        abi: plan.abi,
        functionName: plan.capacityFn,
      }),
      publicClient.readContract({
        address: deployment.contractAddr,
        abi: plan.abi,
        functionName: 'balanceOf',
        args: plan.balanceArgs(account.address),
      }),
      publicClient.getBalance({ address: account.address }),
    ]);
    price = BigInt(price);
    issued = BigInt(issued);
    capacity = BigInt(capacity);
    heldBefore = BigInt(heldBefore);
    walletBalance = BigInt(walletBalance);
  } catch {
    throw new AcquireError('RPC_UNAVAILABLE', 'Unable to read the complete purchase state from RPC.', 5, base);
  }

  const result = {
    ok: true,
    slug: deployment.slug,
    chainId: deployment.chain.id,
    contractAddr: deployment.contractAddr,
    wallet: account.address,
    tokenStandard,
    purchaseMethod: plan.purchaseMethod,
    alreadyHeld: heldBefore > 0n,
    priceWei: price.toString(),
    price: formatEther(price),
    walletBalanceWei: walletBalance.toString(),
    issued: issued.toString(),
    capacity: capacity > 0n ? capacity.toString() : null,
    estimatedGas: null,
    estimatedMaxGasFeeWei: null,
    confirmationRequired: true,
    txHash: null,
    blockNumber: null,
  };
  if (heldBefore > 0n && options.skipIfHeld) {
    return { plan, simulatedRequest: null, heldBefore, result };
  }
  if (capacity > 0n && issued >= capacity) {
    throw new AcquireError('ACQUIRE_SOLD_OUT', 'This Skill deployment is sold out.', 3, base);
  }
  if (walletBalance < price) {
    throw new AcquireError(
      'INSUFFICIENT_FUNDS',
      'Wallet balance is lower than the exact on-chain purchase price.',
      3,
      {
        ...base,
        priceWei: price.toString(),
        walletBalanceWei: walletBalance.toString(),
      }
    );
  }

  const request = {
    address: deployment.contractAddr,
    abi: plan.abi,
    functionName: plan.purchaseMethod,
    account: account.address,
    value: price,
  };
  let simulatedRequest;
  let estimatedGas;
  try {
    const simulation = await publicClient.simulateContract(request);
    simulatedRequest = simulation.request;
    estimatedGas = BigInt(await publicClient.estimateContractGas(request));
  } catch {
    throw new AcquireError(
      'ACQUIRE_SIMULATION_FAILED',
      'The on-chain purchase simulation failed; no transaction was sent.',
      3,
      base
    );
  }

  let maxFeePerGas;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFeePerGas == null) maxFeePerGas = await publicClient.getGasPrice();
    maxFeePerGas = BigInt(maxFeePerGas);
  } catch {
    try {
      maxFeePerGas = BigInt(await publicClient.getGasPrice());
    } catch {
      throw new AcquireError('RPC_UNAVAILABLE', 'Unable to estimate the purchase transaction fee.', 5, base);
    }
  }
  const estimatedMaxGasFeeWei = estimatedGas * maxFeePerGas;
  if (walletBalance < price + estimatedMaxGasFeeWei) {
    throw new AcquireError(
      'INSUFFICIENT_FUNDS',
      'Wallet balance cannot cover the purchase price and estimated maximum gas fee.',
      3,
      {
        ...base,
        priceWei: price.toString(),
        estimatedMaxGasFeeWei: estimatedMaxGasFeeWei.toString(),
        walletBalanceWei: walletBalance.toString(),
      }
    );
  }

  return {
    plan,
    simulatedRequest,
    heldBefore,
    result: {
      ...result,
      estimatedGas: estimatedGas.toString(),
      estimatedMaxGasFeeWei: estimatedMaxGasFeeWei.toString(),
    },
  };
}

export async function acquireSkill(options = {}, providedDependencies = {}) {
  validateOptions(options);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...providedDependencies };
  const deployment = await resolveDeployment(options, dependencies);
  const cfg = dependencies.loadConfig();
  const privateKey = dependencies.resolvePrivateKey(cfg);
  if (!privateKey) {
    throw new AcquireError(
      'WALLET_REQUIRED',
      'Set a valid FINCHIP_PRIVATE_KEY before acquiring a Skill.',
      3,
      {
        slug: deployment.slug,
        chainId: deployment.chain.id,
        contractAddr: deployment.contractAddr,
      }
    );
  }
  const account = dependencies.accountFromPrivateKey(privateKey);
  let publicClient;
  try {
    publicClient = dependencies.publicClientFactory(deployment.chain.id, cfg.rpc);
  } catch {
    throw new AcquireError(
      'RPC_UNAVAILABLE',
      'Unable to create a client for the selected deployment RPC.',
      5,
      {
        slug: deployment.slug,
        chainId: deployment.chain.id,
        contractAddr: deployment.contractAddr,
      }
    );
  }

  const tokenStandard = await resolveTokenStandard(
    publicClient,
    deployment.contractAddr,
    Boolean(options.fork)
  );
  const prepared = await preflight(publicClient, deployment, account, tokenStandard, {
    skipIfHeld: !options.force,
  });
  const preview = prepared.result;

  if (preview.alreadyHeld && !options.force) {
    return {
      ...preview,
      code: 'ACQUIRE_ALREADY_HELD',
      confirmationRequired: false,
    };
  }
  if (options.dryRun) return { ...preview, code: 'ACQUIRE_DRY_RUN' };
  if (!options.yes) {
    throw new AcquireError(
      'ACQUIRE_CONFIRM_REQUIRED',
      'Purchase preflight passed. Re-run with --yes to broadcast, or --dry-run for a successful read-only result.',
      3,
      failureDetails(preview)
    );
  }

  let walletClient;
  try {
    ({ client: walletClient } = dependencies.walletClientFactory(
      deployment.chain.id,
      privateKey,
      cfg.rpc
    ));
  } catch {
    throw new AcquireError(
      'RPC_UNAVAILABLE',
      'Unable to create a wallet client for the selected deployment RPC.',
      5,
      failureDetails(preview)
    );
  }

  let txHash;
  try {
    txHash = await walletClient.writeContract({
      ...prepared.simulatedRequest,
      account,
      gas: BigInt(preview.estimatedGas) + BigInt(preview.estimatedGas) / GAS_BUFFER_DIVISOR,
    });
  } catch {
    throw new AcquireError(
      'ACQUIRE_TX_FAILED',
      'The purchase transaction could not be broadcast.',
      5,
      failureDetails(preview)
    );
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: TX_TIMEOUT_MS,
      pollingInterval: 4_000,
    });
  } catch {
    throw new AcquireError(
      'ACQUIRE_RESULT_UNKNOWN',
      'The transaction was broadcast, but its final result is unknown. Check the receipt or library before retrying.',
      5,
      failureDetails(preview, { txHash, retrySafe: false })
    );
  }
  if (receipt.status !== 'success') {
    throw new AcquireError(
      'ACQUIRE_TX_FAILED',
      'The purchase transaction reverted.',
      5,
      failureDetails(preview, { txHash, blockNumber: receipt.blockNumber?.toString() ?? null })
    );
  }

  let heldAfter;
  try {
    heldAfter = BigInt(await publicClient.readContract({
      address: deployment.contractAddr,
      abi: prepared.plan.abi,
      functionName: 'balanceOf',
      args: prepared.plan.balanceArgs(account.address),
    }));
  } catch {
    throw new AcquireError(
      'ACQUIRE_VERIFY_FAILED',
      'The transaction succeeded, but the resulting holding could not be verified.',
      5,
      failureDetails(preview, { txHash, blockNumber: receipt.blockNumber?.toString() ?? null })
    );
  }
  if (heldAfter <= prepared.heldBefore) {
    throw new AcquireError(
      'ACQUIRE_VERIFY_FAILED',
      'The transaction succeeded, but the wallet holding did not increase.',
      5,
      failureDetails(preview, { txHash, blockNumber: receipt.blockNumber?.toString() ?? null })
    );
  }

  return {
    ...preview,
    code: 'ACQUIRE_COMPLETE',
    confirmationRequired: false,
    txHash,
    blockNumber: receipt.blockNumber?.toString() ?? null,
  };
}

function renderPreflight(result) {
  hd('FinChip CLI — acquire');
  sep();
  ok(`${result.slug} · ${result.tokenStandard}`);
  inf(`wallet:   ${result.wallet}`);
  inf(`chain:    ${fmtChain(result.chainId)}`);
  inf(`contract: ${result.contractAddr}`);
  inf(`price:    ${fmtWei(BigInt(result.priceWei), result.chainId)} (${result.priceWei} wei)`);
  inf(`issued:   ${result.issued}${result.capacity == null ? '' : ` / ${result.capacity}`}`);
  inf(`held:     ${result.alreadyHeld ? 'yes' : 'no'}`);
  inf(`gas:      ${result.estimatedGas ?? 'not needed'}`);
  inf(`max fee:  ${result.estimatedMaxGasFeeWei == null ? 'not needed' : `${result.estimatedMaxGasFeeWei} wei`}`);
}

export async function cmdAcquire(options = {}) {
  try {
    const result = await acquireSkill(options);
    emitResult(options, result, () => {
      renderPreflight(result);
      if (result.code === 'ACQUIRE_DRY_RUN') {
        inf('Dry run only. No transaction was signed or broadcast.');
      } else if (result.code === 'ACQUIRE_ALREADY_HELD') {
        inf('Already held. Use --force --yes only if another purchase is intentional.');
      } else {
        ok(`Acquired · block ${result.blockNumber}`);
        inf(`tx:       ${result.txHash}`);
        inf(`explorer: ${fmtTxLink(result.txHash, result.chainId)}`);
      }
    });
  } catch (error) {
    if (!options.json && error?.code === 'ACQUIRE_CONFIRM_REQUIRED') {
      renderPreflight(error.details);
    }
    emitFailure(options, error, {
      code: 'ACQUIRE_TX_FAILED',
      message: 'Skill acquisition failed.',
    });
  }
}
