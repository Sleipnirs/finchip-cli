// FinChip CLI — command registration and execution
//
// Commands:
//   Account      — login, status, logout
//   Operate      — market, acquire, skill publish/manage, download, trade, library
//   Configure    — config get/set/unset
//   Inspect      — protocol, chains, doctor
//   Commerce     — pay (x402 client)
//   Advanced     — AgentRegistry identity init, verify, register

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read package.json for version (single source of truth)
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath   = join(__dirname, '..', 'package.json');
const pkg       = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Command imports
import { cmdInit }                                          from '../src/commands/init.js';
import { cmdVerify }                                        from '../src/commands/verify.js';
import { cmdRegister }                                      from '../src/commands/register.js';
import { cmdMarketList, cmdMarketSearch }                   from '../src/commands/market.js';
import { cmdAcquire }                                       from '../src/commands/acquire.js';
import { cmdTradeList, cmdTradeBuy, cmdTradeSell, cmdTradeCancel } from '../src/commands/trade.js';
import { cmdConfigGet, cmdConfigSet, cmdConfigUnset }       from '../src/commands/config.js';
import { cmdLibrary }                                       from '../src/commands/library.js';
import { cmdProtocolInfo }                                  from '../src/commands/protocol.js';
import { cmdChains }                                        from '../src/commands/chains.js';
import { cmdDoctor }                                        from '../src/commands/doctor.js';
import { cmdPay }                                           from '../src/commands/pay.js';
import { cmdLogin, cmdStatus, cmdLogout }                    from '../src/commands/auth.js';
import { cmdTaskRun, cmdTaskList, cmdTaskShow, cmdTaskResume, cmdTaskDeny } from '../src/commands/task.js';
import { cmdSiteOpen }                                      from '../src/commands/site.js';
import {
  cmdWalletCreate,
  cmdWalletMigrate,
  cmdWalletStatus,
  cmdWalletUse,
} from '../src/commands/wallet.js';
import { registerSkillCommands }                             from '../src/commands/skill.js';
import { registerDeprecatedPublishCommands }                 from '../src/commands/deprecated.js';
import { cmdDownload }                                       from '../src/commands/download.js';
import { c, emitFailure }                                   from '../src/utils.js';
import { assertNoPublicOriginOverride }                     from '../src/site-origin.js';

const program = new Command();
let activeCommandOptions = {};

program
  .name('finchip')
  .description('FinChip Protocol CLI — A2A-native client for on-chain AI skill tokens')
  .version(pkg.version, '-v, --version', 'output the CLI version');

// ── Account ──────────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate a FinChip account by signing with the configured wallet')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdLogin);

program
  .command('status')
  .description('Show the active FinChip account session')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdStatus);

program
  .command('logout')
  .description('Revoke and remove the active FinChip account session')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdLogout);

const task = program.command('task').description('Run and inspect wallet-bound FinChip Agent Tasks');

task.command('run <task-url>')
  .description('Claim a login or business Task from an official finchip.ai URL')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdTaskRun);

task.command('list')
  .description('List wallet-bound Site Tasks and local recovery records')
  .option('--status <status>', 'Filter Site Tasks by status')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdTaskList);

task.command('show <task-id>')
  .description('Show the current Site state for a Task')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdTaskShow);

task.command('resume <task-id>')
  .description('Re-preflight a Task; --yes approves the exact unchanged plan and broadcasts once')
  .option('--yes', 'Explicitly approve the displayed plan and broadcast')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdTaskResume);

task.command('deny <task-id>')
  .description('Deny the locally verified execution plan for a Task')
  .option('--reason <code>', 'Local denial reason code', 'human_denied')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdTaskDeny);

const site = program.command('site').description('Open wallet-bound FinChip Site views');

site.command('open')
  .description('Open a wallet-bound Site view through a one-time browser handoff')
  .requiredOption('--view <view>', 'Site view (creator)')
  .option('--skill <slug>', 'Open a specific Creator Skill')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdSiteOpen);

const wallet = program.command('wallet').description('Create, select, inspect, or migrate a dedicated Agent wallet');

wallet
  .command('create')
  .description('Create and select a new low-value Agent EOA key file')
  .option('--file <path>', 'Key-file path (default: ~/.finchip/wallets/agent.key)')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdWalletCreate);

wallet
  .command('use')
  .description('Select an existing key file and log out a session for a different wallet')
  .requiredOption('--file <path>', 'Existing private-key file')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdWalletUse);

wallet
  .command('status')
  .description('Show the active wallet source and public address without network access')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdWalletStatus);

wallet
  .command('migrate')
  .description('Move legacy config.privateKey into a private key file')
  .option('--file <path>', 'Destination key-file path')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdWalletMigrate);

// ── Operate · market ─────────────────────────────────────────────────────────
const market = program.command('market').description('Browse the legacy chain-scanned chip market');

market
  .command('list')
  .description('List chips by scanning a chain registry')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--limit <n>',       'Max chips to show', '20')
  .option('--category <cat>',  'Filter by category')
  .action(cmdMarketList);

market
  .command('search')
  .description('Legacy list alias with a broader default limit')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--limit <n>',       'Max chips to show', '50')
  .option('--category <cat>',  'Filter by category')
  .action(cmdMarketSearch);

// ── Operate · acquire ────────────────────────────────────────────────────────
program
  .command('acquire')
  .description('Preflight or purchase a license (ERC-1155) or fork (ERC-721)')
  .requiredOption('--slug <slug>', 'Skill slug (e.g. audit-pro-finchip; legacy _finchip is accepted)')
  .option('--chain <chainId>',     'Chain ID or key')
  .option('--addr <contract>',      'Exact deployment contract address')
  .option('--fork',                'Use the legacy ERC-721 fork path')
  .option('--force',               'Allow another purchase when already holding')
  .option('--dry-run',             'Run the complete read-only purchase preflight')
  .option('--yes',                 'Explicitly confirm signing and broadcasting the purchase')
  .option('--max-price <amount>',  'Refuse when the exact on-chain price exceeds this native amount')
  .option('--max-gas-fee <amount>','Refuse when the estimated maximum gas fee exceeds this native amount')
  .option('--json',                'Emit machine-readable JSON')
  .action(cmdAcquire);

registerSkillCommands(program);
registerDeprecatedPublishCommands(program);

program
  .command('download <slug>')
  .description('Download and decrypt a licensed Skill package without installing or executing it')
  .option('--chain <chainId>', 'Deployment chain ID or key')
  .option('--addr <contract>', 'Deployment contract address')
  .option('--dir <directory>', 'Output directory', '.')
  .option('--force', 'Overwrite an existing output file')
  .option('--no-provenance', 'Preserve byte-for-byte decrypted content without Oracle provenance injection')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdDownload);

// ── Operate · trade ──────────────────────────────────────────────────────────
const trade = program.command('trade').description('Secondary market trading');

trade
  .command('list')
  .description('Show active listings')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--limit <n>',       'Max listings to show', '20')
  .action(cmdTradeList);

trade
  .command('buy')
  .description('Buy a secondary market listing')
  .requiredOption('--id <id>', 'Listing ID')
  .option('--qty <qty>',       'Quantity to buy', '1')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--yes',             'Explicitly confirm signing and broadcasting the purchase')
  .action(cmdTradeBuy);

trade
  .command('sell')
  .description('List a chip token for sale')
  .requiredOption('--slug <slug>',   'Chip slug')
  .requiredOption('--price <price>', 'Price per unit in native currency')
  .option('--qty <qty>',             'Quantity (ERC-1155 only)', '1')
  .option('--token-id <id>',         'Token ID (required for ERC-721)')
  .option('--fork',                  'Force ERC-721 path')
  .option('--chain <chainId>',       'Chain ID or key')
  .option('--yes',                   'Explicitly confirm approval and listing transactions')
  .action(cmdTradeSell);

trade
  .command('cancel')
  .description('Cancel an active listing')
  .requiredOption('--id <id>', 'Listing ID')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--yes',             'Explicitly confirm signing and broadcasting the cancellation')
  .action(cmdTradeCancel);

// ── Operate · library ────────────────────────────────────────────────────────
program
  .command('library')
  .description('Show active-catalog Skill holdings with batched on-chain verification')
  .option('--wallet <addr>',   'Wallet address (defaults to one derived from private key)')
  .option('--chain <chainId>', 'Filter to a single chain')
  .option('--json',            'Emit machine-readable JSON')
  .action(cmdLibrary);

// ── Configure ────────────────────────────────────────────────────────────────
const config = program.command('config').description('Manage non-wallet local CLI configuration');

config
  .command('get [key]')
  .description('Show config (or a specific key)')
  .action(cmdConfigGet);

config
  .command('set <key> <value>')
  .description('Set a non-wallet config value')
  .option('--json', 'Emit machine-readable JSON')
  .action(cmdConfigSet);

config
  .command('unset <key>')
  .description('Remove a config value')
  .action(cmdConfigUnset);

// ── Inspect ──────────────────────────────────────────────────────────────────
program
  .command('protocol')
  .description('Show full protocol state for a chain (on-chain + A2A endpoints)')
  .option('--chain <chainId>', 'Chain ID or key (defaults to saved config)')
  .action(cmdProtocolInfo);

program
  .command('chains')
  .description('List all supported chains + hardcoded AgentRegistry addresses')
  .action(cmdChains);

program
  .command('doctor')
  .description('Full health check: hardcoded / A2A endpoints / on-chain + drift detection')
  .option('-v, --verbose', 'Show every discovered address')
  .action(cmdDoctor);

// ── Commerce · x402 client ───────────────────────────────────────────────────
program
  .command('pay <url>')
  .description('Consume an HTTP 402 x402 payment challenge (sign EIP-3009 USDC auth)')
  .option('--dry-run', 'Probe + show payment plan, but do NOT sign or send')
  .option('--yes', 'Explicitly confirm signing and sending the payment')
  .action(cmdPay);

// ── Advanced · AgentRegistry identity ────────────────────────────────────────
program
  .command('init')
  .description('Advanced: bootstrap an AgentRegistry identity with an fc_key')
  .requiredOption('--key <key>', 'fc_key from https://finchip.ai/a2aentry')
  .option('--chain <chainId>', 'Chain ID or key (56|8453|1|42161|10 / bsc|base|ethereum|arbitrum|optimism)', '56')
  .action(cmdInit);

program
  .command('verify')
  .description('Advanced: verify an fc_key and its AgentRegistry state')
  .option('--key <key>',     'fc_key (uses saved config if omitted)')
  .option('--chain <chainId>', 'Chain ID or key')
  .action(cmdVerify);

program
  .command('register')
  .description('Advanced: register an fc_key on AgentRegistry (requires wallet)')
  .option('--key <key>',         'fc_key (uses saved config if omitted)')
  .option('--perm <perm>',       'Permission: read|acquire|launch|trade|full|0x0F', 'full')
  .option('--wallet-type <type>','Wallet type: eoa|aa|multisig', 'eoa')
  .option('--label <label>',     'Optional agent label')
  .option('--chain <chainId>',   'Chain ID or key')
  .option('--yes',               'Explicitly confirm signing and broadcasting the registration')
  .action(cmdRegister);

// ── Help footer ──────────────────────────────────────────────────────────────
program.addHelpText('after', `
${c.gray}Quick start — consume a Skill:${c.reset}
  finchip skill search "security audit"
  finchip skill show audit-pro-finchip
  finchip wallet create                ${c.gray}# create a low-value dedicated Agent wallet${c.reset}
  finchip login
  finchip acquire --slug audit-pro-finchip --dry-run
  finchip acquire --slug audit-pro-finchip --yes
  finchip download audit-pro-finchip --json

${c.gray}Agent safety:${c.reset}
  Use command-level --json for stable machine-readable output where offered.
  Use --dry-run for read-only preflight; --yes explicitly authorizes a write or transaction.
  Skill commands that accept --addr require --chain and --addr together.
  Use a dedicated low-value Agent wallet; never use a personal or treasury wallet.

${c.gray}AgentRegistry identity (advanced):${c.reset}
  finchip init --help
  finchip register --help
  finchip verify --help

${c.gray}Chains:${c.reset}
  --chain 56     ${c.gray}or --chain bsc        (BSC Mainnet,    BNB)${c.reset}
  --chain 8453   ${c.gray}or --chain base       (Base Mainnet,   ETH)${c.reset}
  --chain 1      ${c.gray}or --chain ethereum   (Ethereum,       ETH)${c.reset}
  --chain 42161  ${c.gray}or --chain arbitrum   (Arbitrum One,   ETH)${c.reset}
  --chain 10     ${c.gray}or --chain optimism   (Optimism,       ETH)${c.reset}
  --chain 421614 ${c.gray}or --chain arbsepolia (Arb Sepolia,    ETH) — internal testnet${c.reset}

${c.gray}CLI docs:${c.reset} https://github.com/Sleipnirs/finchip-cli#readme
${c.gray}A2A docs:${c.reset} https://finchip.ai/a2aentry
${c.gray}npm:${c.reset}      https://www.npmjs.com/package/finchip-cli
`);

program.hook('preAction', (_rootCommand, actionCommand) => {
  activeCommandOptions = actionCommand.opts();
  assertNoPublicOriginOverride(process.env);
});

try {
  await program.parseAsync();
} catch (error) {
  emitFailure(activeCommandOptions, error);
}
