import { formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FinchipAuthClient } from '../auth-client.js';
import { loadConfig, resolveConfiguredPrivateKey } from '../config.js';
import { getPublicClient, getWalletClient } from '../client.js';
import { resolveChain } from '../chains.js';
import { CHIP_ABI, CHIP_721_ABI } from '../protocol.js';
import { cmdPublish } from './publish.js';
import { CliError, emitFailure, emitResult, fmtAddr, fmtChain, hd, inf, ok, sep } from '../utils.js';

const TX_TIMEOUT_MS = 180_000;

const SkillError = CliError;
const fail = (options, error) => emitFailure(options, error, {
  code: 'SKILL_FAILED', message: 'Skill operation failed.',
});

function configurePublish(command) {
  return command
    .description('Publish an encrypted ERC-1155 Skill through the canonical FinChip flow')
    .option('--resume <slug>', 'Resume a previously interrupted publish')
    .option('--slug <slug>', 'Canonical Skill slug (the _finchip suffix is optional)')
    .option('--name <name>', 'Skill name')
    .option('--description <text>', 'Skill description')
    .option('--price <price>', 'License price in native currency')
    .option('--category <category>', 'Skill category (required for a new publish)')
    .option('--encrypt <mode>', 'Encryption: finchip (default) | lit | oracle-v2. Lit sends the raw CK to the Site and Lit/Chipotle')
    .option('--license <license>', 'License name', 'MIT')
    .option('--version <version>', 'Skill version', '1.0.0')
    .option('--cover <pathOrUri>', 'Cover image file or ipfs:// URI')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--royalty-bps <bps>', 'Royalty basis points', '500')
    .option('--max-supply <n>', 'Maximum license supply (0 = unlimited)', '0')
    .option('--chain <chainId>', 'Chain ID or key')
    .option('--dry-run', 'Validate and estimate without uploads or transactions')
    .option('--json', 'Emit machine-readable JSON')
    .action(cmdPublish);
}

export function registerSkillCommands(program) {
  const skill = program.command('skill').description('Publish and manage creator-owned Skills');

  configurePublish(skill.command('publish [path]'));

  skill
    .command('get <slug>')
    .description('Show creator management data for a Skill')
    .option('--chain <chainId>', 'Deployment chain ID or key')
    .option('--addr <contract>', 'Deployment contract address')
    .option('--json', 'Emit machine-readable JSON')
    .action(cmdSkillGet);

  const skillPrice = skill.command('price').description('Manage a Skill deployment price');

  skillPrice
    .command('set <slug>')
    .description('Change the on-chain Skill price and sync the FinChip catalog')
    .option('--chain <chainId>', 'Deployment chain ID or key')
    .option('--addr <contract>', 'Deployment contract address')
    .option('--price <price>', 'New price in native currency')
    .option('--dry-run', 'Validate and estimate without sending a transaction')
    .option('--json', 'Emit machine-readable JSON')
    .action(cmdSkillPriceSet);

  skillPrice
    .command('sync <slug>')
    .description('Retry catalog synchronization for an existing price transaction')
    .option('--chain <chainId>', 'Deployment chain ID or key')
    .option('--addr <contract>', 'Deployment contract address')
    .option('--tx-hash <hash>', 'Existing price transaction hash')
    .option('--json', 'Emit machine-readable JSON')
    .action(cmdSkillPriceSync);

  configurePublish(program.command('publish [path]', { hidden: true }));
}

function deploymentOptions(options, required = false) {
  if (Boolean(options.addr) !== Boolean(options.chain)) {
    throw new SkillError('SKILL_DEPLOYMENT_REQUIRED', '--addr and --chain must be provided together.', 3);
  }
  if (required && (!options.addr || !options.chain)) {
    throw new SkillError('SKILL_DEPLOYMENT_REQUIRED', 'Price changes require both --addr and --chain.', 3);
  }
  if (!options.addr) return { addr: null, chain: null };
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.addr)) throw new SkillError('SKILL_DEPLOYMENT_REQUIRED', 'Invalid contract address.', 3);
  return { addr: options.addr.toLowerCase(), chain: resolveChain(options.chain) };
}

async function context() {
  const client = new FinchipAuthClient();
  const session = await client.requireSession();
  return { client, session };
}

async function manageGet(slug, options, requireDeployment = false) {
  const deployment = deploymentOptions(options, requireDeployment);
  const { client, session } = await context();
  const query = deployment.addr
    ? `?addr=${encodeURIComponent(deployment.addr)}&chainId=${deployment.chain.id}`
    : '';
  const { response, payload } = await client.authenticatedJson(`/api/v2/skills/${encodeURIComponent(slug)}/manage${query}`);
  if (!response.ok) {
    const code = response.status === 404 ? 'SKILL_NOT_FOUND' : response.status === 403 ? 'NOT_CREATOR' : payload.code || 'SKILL_FAILED';
    throw new SkillError(code, payload.error || `Skill request failed with ${response.status}.`, response.status >= 500 ? 5 : 3);
  }
  if (payload.canonicalSlug && payload.canonicalSlug !== slug) {
    throw new SkillError('SKILL_DEPLOYMENT_REQUIRED', `Use canonical slug ${payload.canonicalSlug} for this deployment.`, 3);
  }
  return { client, session, deployment, payload };
}

function summarize(payload) {
  const skill = payload.skill || {};
  return {
    id: skill.id || null,
    slug: skill.slug || null,
    title: skill.title || null,
    description: skill.description || null,
    category: skill.category || null,
    isOnChain: Boolean(skill.is_on_chain),
    contractAddr: skill.chip_address || null,
    chainId: skill.chain_id ?? null,
    tokenType: skill.token_type || null,
    priceWei: skill.price_wei == null ? null : String(skill.price_wei),
    price: skill.price_wei == null ? null : formatEther(BigInt(skill.price_wei)),
  };
}

export async function cmdSkillGet(slug, options = {}) {
  try {
    const { payload } = await manageGet(slug, options);
    const skill = summarize(payload);
    const deployment = {
      contractAddr: skill.contractAddr,
      chainId: skill.chainId,
      tokenType: skill.tokenType,
      priceWei: skill.priceWei,
      price: skill.price,
    };
    const binding = {
      supportedAgentCount: Array.isArray(payload.supportedAgents) ? payload.supportedAgents.length : 0,
      relatedSkillCount: Array.isArray(payload.relatedSkills) ? payload.relatedSkills.length : 0,
      hasStudio: Boolean(payload.studio),
    };
    const result = { ok: true, code: 'SKILL_FOUND', skill, deployment, binding };
    emitResult(options, result, () => {
      hd('FinChip CLI — skill');
      sep();
      ok(skill.slug || slug);
      inf(`title:    ${skill.title || '(not set)'}`);
      inf(`category: ${skill.category || '(not set)'}`);
      inf(`chain:    ${skill.chainId == null ? '(not on-chain)' : fmtChain(skill.chainId)}`);
      inf(`contract: ${skill.contractAddr ? fmtAddr(skill.contractAddr) : '(none)'}`);
      inf(`type:     ${skill.tokenType || '(unknown)'}`);
      inf(`price:    ${skill.price ?? '(unknown)'}`);
      inf(`bindings: ${binding.supportedAgentCount} agents, ${binding.relatedSkillCount} related skills`);
    });
  } catch (error) {
    fail(options, error);
  }
}

async function resolveTokenType(publicClient, addr, hint) {
  if (hint === 'erc1155' || hint === 'erc721') return hint;
  try {
    await publicClient.readContract({ address: addr, abi: CHIP_ABI, functionName: 'licensePrice' });
    return 'erc1155';
  } catch {
    await publicClient.readContract({ address: addr, abi: CHIP_721_ABI, functionName: 'forkPrice' });
    return 'erc721';
  }
}

async function verifyWalletOwnership(session, account, publicClient, addr, tokenType) {
  const wallet = session.wallet?.walletAddr?.toLowerCase();
  if (!wallet || wallet !== account.address.toLowerCase()) {
    throw new SkillError('WALLET_MISMATCH', 'Cookie wallet and private key must match.', 3);
  }
  const abi = tokenType === 'erc721' ? CHIP_721_ABI : CHIP_ABI;
  const creator = await publicClient.readContract({ address: addr, abi, functionName: 'creator' });
  if (String(creator).toLowerCase() !== wallet) {
    throw new SkillError('NOT_CREATOR', 'The configured wallet is not the on-chain Chip creator.', 3);
  }
}

async function syncPrice(client, slug, deployment, txHash) {
  const { response, payload } = await client.authenticatedJson(`/api/v2/skills/${encodeURIComponent(slug)}/manage/price/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addr: deployment.addr, chainId: deployment.chain.id, txHash }),
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (payload.code === 'TX_NOT_VISIBLE') {
      throw new SkillError('PRICE_SYNC_PENDING', payload.error || 'Transaction is not visible to the FinChip RPC yet.', 5, { txHash });
    }
    throw new SkillError('PRICE_SYNC_FAILED', payload.error || `Price sync failed with ${response.status}.`, response.status >= 500 ? 5 : 3, { txHash });
  }
  return payload;
}

export async function cmdSkillPriceSet(slug, options = {}) {
  try {
    const managed = await manageGet(slug, options, true);
    const priceText = String(options.price ?? '');
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(priceText)) {
      throw new SkillError('PRICE_TX_FAILED', 'Price must be a non-negative decimal with up to 18 places.', 3);
    }
    let newPrice;
    try { newPrice = parseEther(priceText); }
    catch { throw new SkillError('PRICE_TX_FAILED', 'Price must be a non-negative decimal with up to 18 places.', 3); }
    const cfg = loadConfig();
    const privateKey = resolveConfiguredPrivateKey(cfg);
    if (!privateKey) throw new SkillError('WALLET_MISMATCH', 'Set a valid FINCHIP_PRIVATE_KEY for this operation.', 3);
    const account = privateKeyToAccount(privateKey);
    const publicClient = getPublicClient(managed.deployment.chain.id, cfg.rpc);
    const tokenType = await resolveTokenType(publicClient, managed.deployment.addr, managed.payload.skill?.token_type);
    await verifyWalletOwnership(managed.session, account, publicClient, managed.deployment.addr, tokenType);
    const abi = tokenType === 'erc721' ? CHIP_721_ABI : CHIP_ABI;
    const readFn = tokenType === 'erc721' ? 'forkPrice' : 'licensePrice';
    const writeFn = tokenType === 'erc721' ? 'setForkPrice' : 'setLicensePrice';
    const currentPrice = await publicClient.readContract({ address: managed.deployment.addr, abi, functionName: readFn });
    const gas = await publicClient.estimateContractGas({
      address: managed.deployment.addr, abi, functionName: writeFn, args: [newPrice], account: account.address,
    });
    if (options.dryRun) {
      const result = {
        ok: true, code: 'PRICE_DRY_RUN', slug, chainId: managed.deployment.chain.id,
        contractAddr: managed.deployment.addr, tokenType, oldPriceWei: currentPrice.toString(),
        newPriceWei: newPrice.toString(), estimatedGas: gas.toString(),
      };
      emitResult(options, result, () => {
        hd('FinChip CLI — price dry run'); sep(); ok(slug);
        inf(`contract: ${fmtAddr(managed.deployment.addr)}`);
        inf(`old:      ${formatEther(currentPrice)}`);
        inf(`new:      ${formatEther(newPrice)}`);
        inf(`gas:      ${gas}`);
      });
      return;
    }
    const { client: walletClient } = getWalletClient(managed.deployment.chain.id, privateKey, cfg.rpc);
    let txHash;
    try {
      txHash = await walletClient.writeContract({
        address: managed.deployment.addr, abi, functionName: writeFn, args: [newPrice], gas: gas + gas / 5n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: TX_TIMEOUT_MS, pollingInterval: 4_000 });
      if (receipt.status !== 'success') throw new Error('Price transaction reverted.');
    } catch (error) {
      throw new SkillError('PRICE_TX_FAILED', error.shortMessage || error.message || 'Price transaction failed.', 5, txHash ? { txHash } : {});
    }
    const synced = await syncPrice(managed.client, slug, managed.deployment, txHash);
    const result = {
      ok: true, code: 'PRICE_UPDATED', slug, chainId: managed.deployment.chain.id,
      contractAddr: managed.deployment.addr, tokenType: synced.tokenType || tokenType,
      priceWei: String(synced.priceWei ?? newPrice), price: String(synced.chipPrice ?? formatEther(newPrice)), txHash,
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — price updated'); sep(); ok(slug);
      inf(`contract: ${fmtAddr(result.contractAddr)}`);
      inf(`price:    ${result.price}`);
      inf(`tx:       ${txHash}`);
    });
  } catch (error) {
    if (!options.json && error instanceof SkillError && error.code === 'PRICE_SYNC_PENDING' && error.details.txHash) {
      inf(`Retry: finchip skill price sync ${slug} --chain ${options.chain} --addr ${options.addr} --tx-hash ${error.details.txHash}`);
    }
    fail(options, error);
  }
}

export async function cmdSkillPriceSync(slug, options = {}) {
  try {
    const managed = await manageGet(slug, options, true);
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.txHash || '')) {
      throw new SkillError('PRICE_SYNC_FAILED', 'A valid --tx-hash is required.', 3);
    }
    const synced = await syncPrice(managed.client, slug, managed.deployment, options.txHash.toLowerCase());
    const result = {
      ok: true, code: 'PRICE_SYNCED', slug, chainId: managed.deployment.chain.id,
      contractAddr: managed.deployment.addr, tokenType: synced.tokenType,
      priceWei: String(synced.priceWei), price: String(synced.chipPrice), txHash: options.txHash.toLowerCase(),
    };
    emitResult(options, result, () => {
      hd('FinChip CLI — price synced'); sep(); ok(slug);
      inf(`contract: ${fmtAddr(result.contractAddr)}`);
      inf(`price:    ${result.price}`);
      inf(`tx:       ${result.txHash}`);
    });
  } catch (error) {
    fail(options, error);
  }
}
