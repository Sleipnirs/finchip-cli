import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

import { buildAcquireExecutionPlan, buildActionExecutionPlan } from './action-intent-contracts.js';
import { CliError } from './utils.js';
import { FinchipAuthClient } from './auth-client.js';
import { getPublicClient, getWalletClient } from './client.js';
import { loadConfig, resolveWalletPrivateKey } from './config.js';
import { resolveProtocol } from './discovery.js';
import { CHIP_ABI, CHIP_721_ABI, MARKET_ABI, IFACE_ID } from './protocol.js';
import { loadManageState } from './commands/manage.js';
import { resolveAttestationTokenType, executeCreatorAttestation } from './creator-attestation.js';
import { TradePreflightPublicClient, ensureTradeListingReady, verifyTradeListingCreator } from './trade-preflight.js';
import { prepareAcquirePlan, executeAcquireWithWriteContract } from './commands/acquire.js';
import { downloadSkill, prepareDownloadSkill } from './commands/download.js';
import { executePublishTask, preparePublishTask } from './commands/publish.js';

function assertDownloadIntent(intent, prepared) {
  if (
    intent.kind !== 'skill.download.v1'
    || prepared.deployment.slug !== intent.skillSlug
    || prepared.deployment.chainId !== intent.chainId
    || prepared.deployment.addr !== intent.contractAddr
  ) {
    throw new CliError('INTENT_STATE_CONFLICT', 'Download preflight does not match the claimed Intent.', 3);
  }
}

async function prepareAcquire(intent, dependencies = {}) {
  const prepared = await prepareAcquirePlan({
    slug: intent.skillSlug,
    chain: String(intent.chainId),
    addr: intent.contractAddr,
    maxPriceWei: intent.maxPriceWei,
    maxGasFeeWei: intent.maxGasFeeWei,
    dryRun: true,
  }, dependencies.acquireDependencies);
  return { prepared, plan: buildAcquireExecutionPlan(prepared.preview, intent, dependencies.planTime || new Date()) };
}

async function executeAcquire(context) {
  return executeAcquireWithWriteContract(context.prepared, {
    // The legacy acquire hook passes (txHash, preview). Agent Tasks have one
    // chain step and their second argument is a numeric step index, so keep
    // that internal preview object out of the Task callback contract.
    onTxHash: txHash => context.onTxHash?.(txHash),
  });
}

async function prepareDownload(intent, dependencies = {}) {
  const prepared = await prepareDownloadSkill(intent.skillSlug, {
    chain: String(intent.chainId),
    addr: intent.contractAddr,
  }, dependencies.downloadDependencies);
  assertDownloadIntent(intent, prepared);
  const encrypted = prepared.manifest.kind === 'ipfs_manifest_v1'
    || prepared.manifest.kind === 'ipfs_encrypted'
    || prepared.manifest.files.some(file => file.encrypted === true);
  const steps = [];
  if (encrypted) {
    steps.push({
      index: steps.length,
      kind: 'wallet_signature',
      action: 'skill.download.authorize',
      target: 'site',
      valueWei: '0',
      estimatedMaxGasFeeWei: '0',
    });
  }
  steps.push({
    index: steps.length,
    kind: 'local_file',
    action: 'skill.download.save',
    target: 'local',
    valueWei: '0',
    estimatedMaxGasFeeWei: '0',
  });
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: intent.walletAddr,
    skillSlug: intent.skillSlug,
    contractAddr: intent.contractAddr,
    tokenStandard: intent.tokenStandard,
    maxValueWei: intent.maxAccessFeeWei,
    estimatedMaxGasFeeWei: '0',
    details: {
      sourceKind: prepared.manifest.kind,
      files: prepared.files.map(file => file.name),
      encrypted,
    },
    steps,
    now: dependencies.planTime || new Date(),
  });
  return { prepared, plan };
}

async function executeDownload(context) {
  const outputDirectory = join(homedir(), 'Downloads', 'FinChip', context.intent.skillSlug);
  return downloadSkill(context.intent.skillSlug, {
    chain: String(context.intent.chainId),
    addr: context.intent.contractAddr,
    dir: outputDirectory,
    force: false,
  }, {
    ...context.dependencies?.downloadDependencies,
    cfg: context.prepared.cfg,
    client: context.prepared.client,
    account: context.prepared.account,
    preparedManifest: context.prepared.manifest,
  });
}

async function loadPublishDraft(intent, dependencies = {}) {
  const client = dependencies.authClient || new FinchipAuthClient();
  const { response, payload } = await client.authenticatedJson(
    `/api/action-intents/publish-drafts/${encodeURIComponent(intent.producerRequest.draftId)}`,
    { timeoutMs: 30_000 },
  );
  if (!response.ok || !payload.draft) {
    throw new CliError(payload.code || 'PUBLISH_DRAFT_NOT_FOUND', payload.error || payload.message || 'Publish draft could not be loaded.', response.status >= 500 ? 5 : 3);
  }
  if (Number(payload.draft.chainId) !== intent.chainId
      || String(payload.draft.factoryAddr).toLowerCase() !== intent.contractAddr.toLowerCase()) {
    throw new CliError('INTENT_STATE_CONFLICT', 'Publish draft deployment does not match the claimed Task.', 3);
  }
  return { client, draft: payload.draft };
}

async function preparePublish(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const { client, draft } = await loadPublishDraft(intent, dependencies);
  const sourcePath = dependencies.localSourcePath;
  const preview = await preparePublishTask(sourcePath, draft);
  const fee = await maximumGasFee(context.publicClient, BigInt(preview.estimatedGas) + 500_000n);
  if (fee.estimatedMaxGasFeeWei > BigInt(intent.maxGasFeeWei)) {
    throw new CliError('TASK_BUDGET_EXCEEDED', 'The publish gas estimate exceeds the Task budget.', 3, {
      limitWei: intent.maxGasFeeWei,
      actualWei: fee.estimatedMaxGasFeeWei.toString(),
    });
  }
  const deployGasFee = fee.estimatedMaxGasFeeWei * BigInt(preview.estimatedGas) / (BigInt(preview.estimatedGas) + 500_000n);
  const keyGasFee = fee.estimatedMaxGasFeeWei - deployGasFee;
  const steps = [
    { index: 0, kind: 'local_file', action: 'skill.publish.prepare-source', target: 'local', valueWei: '0', estimatedMaxGasFeeWei: '0' },
    { index: 1, kind: 'site_mutation', action: 'skill.publish.upload', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0' },
    { index: 2, kind: 'chain_transaction', action: 'skill.publish.deploy', target: intent.contractAddr, valueWei: '0', estimatedMaxGasFeeWei: deployGasFee.toString() },
    { index: 3, kind: 'site_mutation', action: 'skill.publish.register', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0' },
    { index: 4, kind: 'wallet_signature', action: 'skill.publish.envelope', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0' },
    { index: 5, kind: 'chain_transaction', action: 'skill.publish.set-key', target: `deployment:${draft.slug}`, valueWei: '0', estimatedMaxGasFeeWei: keyGasFee.toString() },
    { index: 6, kind: 'site_mutation', action: 'skill.publish.finalize', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0' },
  ];
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: context.account.address,
    skillSlug: draft.slug,
    contractAddr: intent.contractAddr,
    tokenStandard: 'ERC-1155',
    maxValueWei: intent.producerRequest.maxTotalValueWei,
    estimatedMaxGasFeeWei: fee.estimatedMaxGasFeeWei.toString(),
    details: {
      draftHash: draft.draftHash,
      name: draft.payload.name,
      category: String(draft.payload.category),
      license: String(draft.payload.license),
      priceWei: String(draft.payload.priceWei),
      maxSupply: String(draft.payload.maxSupply),
      royaltyBps: String(draft.payload.royaltyBps),
      imageURI: String(draft.payload.imageURI || 'ipfs://bafybeiaal47ha2ovfvttgiox4a6xzo4hes4kavjtpuhkrpagud5wjj7yl4'),
      encryptionMode: String(draft.payload.encryptionMode),
      primary: preview.primary,
      files: preview.sourceFiles,
      excludedFiles: preview.excludedFiles.map(item => item.path),
      sourceCollectionMode: preview.sourceCollectionMode,
      preflightMode: 'local-source-validation-and-deploy-simulation',
    },
    steps,
    now: dependencies.planTime || new Date(),
  });
  return { prepared: { ...context, client, draft, sourcePath }, plan };
}

async function executePublish(context) {
  return executePublishTask(context.prepared.sourcePath, context.prepared.draft, {
    onTxHash: context.onTxHash,
    onStepComplete: context.onStepComplete,
  });
}

function taskWalletContext(intent) {
  const cfg = loadConfig();
  const privateKey = resolveWalletPrivateKey(cfg);
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== intent.walletAddr.toLowerCase()) {
    throw new CliError('WALLET_MISMATCH', 'The selected Agent wallet does not match this Task.', 3);
  }
  const publicClient = getPublicClient(intent.chainId, cfg.rpc);
  return { cfg, privateKey, account, publicClient, chainId: intent.chainId };
}

async function maximumGasFee(publicClient, estimatedGas) {
  let maxFeePerGas;
  try {
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  } catch { /* fall through */ }
  maxFeePerGas ??= await publicClient.getGasPrice();
  const broadcastGas = BigInt(estimatedGas) + BigInt(estimatedGas) / 5n;
  return { broadcastGas, estimatedMaxGasFeeWei: broadcastGas * BigInt(maxFeePerGas) };
}

async function prepareContractWrite(intent, request, details, action, context, options = {}) {
  let simulationRequest = request;
  let estimatedGas;
  if (options.simulate !== false) {
    const simulation = await context.publicClient.simulateContract(request);
    simulationRequest = simulation.request;
    estimatedGas = await context.publicClient.estimateContractGas(request);
  } else {
    estimatedGas = options.estimatedGas;
  }
  const fee = await maximumGasFee(context.publicClient, estimatedGas);
  if (fee.estimatedMaxGasFeeWei > BigInt(intent.maxGasFeeWei)) {
    throw new CliError('TASK_BUDGET_EXCEEDED', 'The estimated maximum gas fee exceeds the Task budget.', 3, {
      limitWei: intent.maxGasFeeWei,
      actualWei: fee.estimatedMaxGasFeeWei.toString(),
    });
  }
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: context.account.address,
    skillSlug: intent.skillSlug,
    contractAddr: intent.contractAddr,
    tokenStandard: intent.tokenStandard,
    maxValueWei: options.maxValueWei || '0',
    estimatedMaxGasFeeWei: fee.estimatedMaxGasFeeWei.toString(),
    details,
    steps: [{
      index: 0,
      kind: 'chain_transaction',
      action,
      target: request.address,
      valueWei: String(request.value || 0n),
      estimatedMaxGasFeeWei: fee.estimatedMaxGasFeeWei.toString(),
    }],
    now: options.planTime || new Date(),
  });
  return { prepared: { ...context, request: simulationRequest, broadcastGas: fee.broadcastGas }, plan };
}

async function executeContractWrite({ prepared, onTxHash }) {
  const { client: walletClient } = getWalletClient(prepared.chainId, prepared.privateKey, prepared.cfg.rpc);
  const txHash = await walletClient.writeContract({ ...prepared.request, gas: prepared.broadcastGas });
  await onTxHash?.(txHash);
  const receipt = await prepared.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000, pollingInterval: 4_000 });
  if (receipt.status !== 'success') throw new CliError('TASK_TX_FAILED', 'The Task transaction reverted.', 5, { txHash });
  return { ok: true, txHash, blockNumber: receipt.blockNumber.toString() };
}

async function preparePriceSet(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const client = dependencies.authClient || new FinchipAuthClient();
  const managed = await loadManageState(client, intent.skillSlug, { addr: intent.contractAddr, chainId: intent.chainId });
  const tokenType = String(managed.payload.skill?.token_type).toLowerCase() === 'erc721' ? 'erc721' : 'erc1155';
  const abi = tokenType === 'erc721' ? CHIP_721_ABI : CHIP_ABI;
  const newPriceWei = BigInt(intent.producerRequest.newPriceWei);
  const request = {
    address: intent.contractAddr,
    abi,
    functionName: tokenType === 'erc721' ? 'setForkPrice' : 'setLicensePrice',
    args: [newPriceWei],
    account: context.account.address,
  };
  const currentPrice = await context.publicClient.readContract({
    address: intent.contractAddr,
    abi,
    functionName: tokenType === 'erc721' ? 'forkPrice' : 'licensePrice',
  });
  const base = await prepareContractWrite(intent, request, {
    oldPriceWei: String(currentPrice),
    newPriceWei: newPriceWei.toString(),
  }, 'skill.price.set', context, { planTime: dependencies.planTime });
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: context.account.address,
    skillSlug: intent.skillSlug,
    contractAddr: intent.contractAddr,
    tokenStandard: tokenType === 'erc721' ? 'ERC-721' : 'ERC-1155',
    maxValueWei: '0',
    estimatedMaxGasFeeWei: base.plan.estimatedMaxGasFeeWei,
    details: base.plan.details,
    steps: [
      { ...base.plan.steps[0], index: 0 },
      { index: 1, kind: 'site_mutation', action: 'skill.price.sync', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0' },
    ],
    now: dependencies.planTime || new Date(),
  });
  return { prepared: { ...base.prepared, client, canonicalSlug: managed.canonicalSlug, newPriceWei: newPriceWei.toString() }, plan };
}

async function executePriceSet(context) {
  const chainResult = await executeContractWrite(context);
  await context.onStepComplete?.(0, { txHash: chainResult.txHash });
  const { response, payload } = await context.prepared.client.authenticatedJson(
    `/api/v2/skills/${encodeURIComponent(context.prepared.canonicalSlug)}/manage/price/sync`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addr: context.intent.contractAddr, chainId: context.intent.chainId, txHash: chainResult.txHash }),
      timeoutMs: 30_000,
    },
  );
  if (!response.ok) throw new CliError(payload.code || 'PRICE_SYNC_FAILED', payload.error || 'Price sync failed.', response.status >= 500 ? 5 : 3, { txHash: chainResult.txHash });
  await context.onStepComplete?.(1, { resultSummary: { priceWei: String(payload.priceWei ?? context.prepared.newPriceWei) } });
  return { ...chainResult, priceWei: String(payload.priceWei ?? context.prepared.newPriceWei) };
}

async function prepareTradeBuy(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const proto = await resolveProtocol(intent.chainId, context.cfg.rpc);
  if (proto.market.toLowerCase() !== intent.contractAddr.toLowerCase()) throw new CliError('INTENT_STATE_CONFLICT', 'Trade market deployment changed.', 3);
  const listingId = BigInt(intent.producerRequest.listingId);
  const quantity = BigInt(intent.producerRequest.quantity);
  const listing = await context.publicClient.readContract({ address: proto.market, abi: MARKET_ABI, functionName: 'getListing', args: [listingId] });
  if (!listing.active) throw new CliError('TRADE_LISTING_INACTIVE', 'The listing is no longer active.', 3);
  if (BigInt(listing.pricePerUnit) > BigInt(intent.producerRequest.maxUnitPriceWei)) throw new CliError('TASK_BUDGET_EXCEEDED', 'The listing unit price exceeds the Task budget.', 3);
  const total = BigInt(listing.pricePerUnit) * quantity;
  if (total > BigInt(intent.producerRequest.maxTotalPriceWei)) throw new CliError('TASK_BUDGET_EXCEEDED', 'The listing total exceeds the Task budget.', 3);
  return prepareContractWrite(intent, {
    address: proto.market, abi: MARKET_ABI, functionName: 'buyListing', args: [listingId, quantity], value: total, account: context.account.address,
  }, { listingId: listingId.toString(), quantity: quantity.toString(), unitPriceWei: String(listing.pricePerUnit) }, 'trade.buy', context, {
    maxValueWei: intent.producerRequest.maxTotalPriceWei,
    planTime: dependencies.planTime,
  });
}

async function prepareTradeCancel(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const proto = await resolveProtocol(intent.chainId, context.cfg.rpc);
  if (proto.market.toLowerCase() !== intent.contractAddr.toLowerCase()) throw new CliError('INTENT_STATE_CONFLICT', 'Trade market deployment changed.', 3);
  const listingId = BigInt(intent.producerRequest.listingId);
  const listing = await context.publicClient.readContract({ address: proto.market, abi: MARKET_ABI, functionName: 'getListing', args: [listingId] });
  if (!listing.active || String(listing.seller).toLowerCase() !== context.account.address.toLowerCase()) throw new CliError('NOT_SELLER', 'The selected wallet cannot cancel this listing.', 3);
  return prepareContractWrite(intent, {
    address: proto.market, abi: MARKET_ABI, functionName: 'cancelListing', args: [listingId], account: context.account.address,
  }, { listingId: listingId.toString() }, 'trade.cancel', context, { planTime: dependencies.planTime });
}

async function prepareCreatorAttest(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const client = dependencies.authClient || new FinchipAuthClient();
  const session = await client.requireSession({ walletRequired: true });
  const managed = await loadManageState(client, intent.skillSlug, { addr: intent.contractAddr, chainId: intent.chainId });
  const tokenType = await resolveAttestationTokenType(context.publicClient, intent.contractAddr, managed.payload.skill?.token_type);
  const validated = await executeCreatorAttestation({
    chainId: intent.chainId,
    contractAddr: intent.contractAddr,
    tokenType,
    sessionWallet: session.wallet?.walletAddr || session.identity?.walletAddr,
    account: context.account,
    publicClient: context.publicClient,
    walletClient: null,
    dryRun: true,
  });
  const fee = await maximumGasFee(context.publicClient, 350_000n);
  if (fee.estimatedMaxGasFeeWei > BigInt(intent.maxGasFeeWei)) throw new CliError('TASK_BUDGET_EXCEEDED', 'The conservative Creator Attestation gas cap exceeds the Task budget.', 3);
  const steps = validated.code === 'CREATOR_ALREADY_VERIFIED' ? [{
    index: 0, kind: 'site_mutation', action: 'skill.creator-attest.already-verified', target: 'site', valueWei: '0', estimatedMaxGasFeeWei: '0',
  }] : [
    { index: 0, kind: 'wallet_signature', action: 'skill.creator-attest.sign', target: intent.contractAddr, valueWei: '0', estimatedMaxGasFeeWei: '0' },
    { index: 1, kind: 'chain_transaction', action: 'skill.creator-attest', target: intent.contractAddr, valueWei: '0', estimatedMaxGasFeeWei: fee.estimatedMaxGasFeeWei.toString() },
  ];
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: context.account.address,
    skillSlug: intent.skillSlug,
    contractAddr: intent.contractAddr,
    tokenStandard: tokenType === 'erc721' ? 'ERC-721' : 'ERC-1155',
    maxValueWei: '0',
    estimatedMaxGasFeeWei: validated.code === 'CREATOR_ALREADY_VERIFIED' ? '0' : fee.estimatedMaxGasFeeWei.toString(),
    details: { digest: validated.digest || 'already-verified', preflightMode: 'digest-read-validation' },
    steps,
    now: dependencies.planTime || new Date(),
  });
  return { prepared: { ...context, client, session, tokenType, validated }, plan };
}

async function executeCreatorAttest(context) {
  if (context.prepared.validated.code === 'CREATOR_ALREADY_VERIFIED') return { ok: true, txHash: null };
  const { client: walletClient } = getWalletClient(context.intent.chainId, context.prepared.privateKey, context.prepared.cfg.rpc);
  return executeCreatorAttestation({
    chainId: context.intent.chainId,
    contractAddr: context.intent.contractAddr,
    tokenType: context.prepared.tokenType,
    sessionWallet: context.prepared.session.wallet?.walletAddr || context.prepared.session.identity?.walletAddr,
    account: context.prepared.account,
    publicClient: context.prepared.publicClient,
    walletClient,
    yes: true,
    onTxHash: context.onTxHash,
  });
}

async function prepareTradeList(intent, dependencies = {}) {
  const context = taskWalletContext(intent);
  const proto = await resolveProtocol(intent.chainId, context.cfg.rpc);
  const producer = intent.producerRequest;
  const isFork = producer.assetKind === 'fork';
  const tokenId = BigInt(producer.tokenId);
  const quantity = BigInt(producer.quantity);
  const priceWei = BigInt(producer.pricePerUnitWei);
  const preflightInput = {
    chainId: intent.chainId,
    chipAddr: intent.contractAddr,
    seller: context.account.address,
    tokenId: tokenId.toString(),
    quantity: quantity.toString(),
    priceWei: priceWei.toString(),
    standard: isFork ? 'erc721' : 'erc1155',
  };
  const preflightClient = new TradePreflightPublicClient();
  const initial = await preflightClient.preflight(preflightInput);
  if (!initial.ok && initial.code !== 'TRADE_APPROVAL_REQUIRED') {
    throw new CliError(initial.code || 'TRADE_PREFLIGHT_UNAVAILABLE', initial.error || 'Trade listing preflight failed.', 3);
  }
  const creator = await verifyTradeListingCreator({
    siteCreatorAddr: initial.creatorAddr,
    readCreator: () => context.publicClient.readContract({
      address: intent.contractAddr,
      abi: isFork ? CHIP_721_ABI : CHIP_ABI,
      functionName: 'creator',
    }),
  });
  const approvalRequired = initial.code === 'TRADE_APPROVAL_REQUIRED';
  const steps = [];
  let approval = null;
  let estimatedMaxGasFeeWei;
  if (approvalRequired) {
    const approvalRequest = {
      address: intent.contractAddr,
      abi: isFork ? CHIP_721_ABI : CHIP_ABI,
      functionName: 'setApprovalForAll',
      args: [proto.market, true],
      account: context.account.address,
    };
    const approvalSimulation = await context.publicClient.simulateContract(approvalRequest);
    const approvalEstimate = await context.publicClient.estimateContractGas(approvalRequest);
    const approvalFee = await maximumGasFee(context.publicClient, approvalEstimate);
    if (approvalFee.estimatedMaxGasFeeWei >= BigInt(intent.maxGasFeeWei)) throw new CliError('TASK_BUDGET_EXCEEDED', 'The Market approval alone exhausts the Task gas budget.', 3);
    approval = { request: approvalSimulation.request, broadcastGas: approvalFee.broadcastGas };
    estimatedMaxGasFeeWei = BigInt(intent.maxGasFeeWei);
    steps.push({
      index: 0, kind: 'chain_transaction', action: 'trade.approve', target: intent.contractAddr, valueWei: '0',
      estimatedMaxGasFeeWei: approvalFee.estimatedMaxGasFeeWei.toString(),
    });
    steps.push({
      index: 1, kind: 'chain_transaction', action: 'trade.list', target: proto.market, valueWei: '0',
      estimatedMaxGasFeeWei: (estimatedMaxGasFeeWei - approvalFee.estimatedMaxGasFeeWei).toString(),
    });
  } else {
    const fee = await maximumGasFee(context.publicClient, BigInt(initial.estimatedGas));
    if (fee.estimatedMaxGasFeeWei > BigInt(intent.maxGasFeeWei)) throw new CliError('TASK_BUDGET_EXCEEDED', 'The listing gas estimate exceeds the Task budget.', 3);
    estimatedMaxGasFeeWei = fee.estimatedMaxGasFeeWei;
    steps.push({
      index: 0, kind: 'chain_transaction', action: 'trade.list', target: proto.market, valueWei: '0',
      estimatedMaxGasFeeWei: fee.estimatedMaxGasFeeWei.toString(),
    });
  }
  const plan = buildActionExecutionPlan({
    intent,
    walletAddr: context.account.address,
    skillSlug: intent.skillSlug,
    contractAddr: intent.contractAddr,
    tokenStandard: isFork ? 'ERC-721' : 'ERC-1155',
    maxValueWei: '0',
    estimatedMaxGasFeeWei: estimatedMaxGasFeeWei.toString(),
    details: {
      chipAddr: intent.contractAddr,
      creator,
      tokenId: tokenId.toString(),
      quantity: quantity.toString(),
      pricePerUnitWei: priceWei.toString(),
      approvalRequired,
      availableQuantity: String(initial.availableQuantity),
      preflightMode: approvalRequired ? 'policy-validation-before-approval' : 'simulation',
    },
    steps,
    now: dependencies.planTime || new Date(),
  });
  return { prepared: { ...context, proto, producer, preflightInput, preflightClient, creator, approval, approvalRequired }, plan };
}

async function executeTradeList(context) {
  const prepared = context.prepared;
  const { client: walletClient } = getWalletClient(context.intent.chainId, prepared.privateKey, prepared.cfg.rpc);
  const stepTxHashes = {};
  let listStepIndex = 0;
  if (prepared.approvalRequired) {
    const approvalHash = await walletClient.writeContract({ ...prepared.approval.request, gas: prepared.approval.broadcastGas });
    stepTxHashes[0] = approvalHash;
    await context.onTxHash?.(approvalHash, 0);
    const approvalReceipt = await prepared.publicClient.waitForTransactionReceipt({ hash: approvalHash, timeout: 180_000, pollingInterval: 4_000 });
    if (approvalReceipt.status !== 'success') throw new CliError('TRADE_APPROVAL_FAILED', 'The Market approval reverted.', 5, { txHash: approvalHash });
    await context.onStepComplete?.(0, { txHash: approvalHash });
    listStepIndex = 1;
  }
  const ready = await ensureTradeListingReady({
    preflight: () => prepared.preflightClient.preflight(prepared.preflightInput),
    expected: { chainId: context.intent.chainId, marketAddr: prepared.proto.market, chipAddr: context.intent.contractAddr, seller: prepared.account.address },
    approve: async () => { throw new CliError('INTENT_STATE_CONFLICT', 'The approved Task did not include a newly required Market approval.', 3); },
  });
  const creator = await verifyTradeListingCreator({
    siteCreatorAddr: ready.creatorAddr,
    readCreator: () => prepared.publicClient.readContract({
      address: context.intent.contractAddr,
      abi: prepared.producer.assetKind === 'fork' ? CHIP_721_ABI : CHIP_ABI,
      functionName: 'creator',
    }),
  });
  const request = {
    address: prepared.proto.market,
    abi: MARKET_ABI,
    functionName: 'listToken',
    args: [
      context.intent.contractAddr,
      creator,
      BigInt(prepared.producer.tokenId),
      BigInt(prepared.producer.quantity),
      BigInt(prepared.producer.pricePerUnitWei),
      prepared.producer.assetKind === 'fork' ? 1 : 0,
    ],
    account: prepared.account.address,
  };
  const simulation = await prepared.publicClient.simulateContract(request);
  const estimatedGas = await prepared.publicClient.estimateContractGas(request);
  const fee = await maximumGasFee(prepared.publicClient, estimatedGas);
  if (fee.estimatedMaxGasFeeWei > BigInt(context.plan.steps[listStepIndex].estimatedMaxGasFeeWei)) throw new CliError('TASK_PLAN_CHANGED', 'The post-approval listing gas estimate exceeds the approved step budget.', 3);
  const txHash = await walletClient.writeContract({ ...simulation.request, gas: fee.broadcastGas });
  stepTxHashes[listStepIndex] = txHash;
  await context.onTxHash?.(txHash, listStepIndex);
  const receipt = await prepared.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000, pollingInterval: 4_000 });
  if (receipt.status !== 'success') throw new CliError('TRADE_LIST_FAILED', 'The listing transaction reverted.', 5, { txHash });
  await context.onStepComplete?.(listStepIndex, { txHash });
  return { ok: true, txHash, stepTxHashes };
}

const HANDLERS = new Map([
  ['skill.acquire.v1', { prepare: prepareAcquire, execute: executeAcquire }],
  ['skill.download.v1', { prepare: prepareDownload, execute: executeDownload }],
  ['skill.publish.v1', { prepare: preparePublish, execute: executePublish }],
  ['skill.price.set.v1', { prepare: preparePriceSet, execute: executePriceSet }],
  ['skill.creator-attest.v1', { prepare: prepareCreatorAttest, execute: executeCreatorAttest }],
  ['trade.list.v1', { prepare: prepareTradeList, execute: executeTradeList }],
  ['trade.buy.v1', { prepare: prepareTradeBuy, execute: executeContractWrite }],
  ['trade.cancel.v1', { prepare: prepareTradeCancel, execute: executeContractWrite }],
]);

export function actionIntentHandler(kind) {
  const handler = HANDLERS.get(kind);
  if (!handler) throw new CliError('TASK_ACTION_UNSUPPORTED', `This CLI cannot execute ${kind}. Update FinChip CLI.`, 3);
  return handler;
}
