// FinChip CLI — command registration and execution
//
// Commands:
//   Bootstrap    — init, verify, register
//   Operate      — market, acquire, skill publish/manage, download, trade, library
//   Configure    — config get/set/unset
//   Inspect      — protocol, chains, doctor
//   Commerce     — pay (x402 client)

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
import { registerSkillCommands }                             from '../src/commands/skill.js';
import { registerDeprecatedPublishCommands }                 from '../src/commands/deprecated.js';
import { cmdDownload }                                       from '../src/commands/download.js';
import { c }                                                from '../src/utils.js';

const program = new Command();

program
  .name('finchip')
  .description('FinChip Protocol CLI — A2A-native client for on-chain AI skill tokens')
  .version(pkg.version, '-v, --version', 'output the CLI version');

// ── Bootstrap ────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Bootstrap CLI with your fc_key (saves config + verifies on-chain)')
  .requiredOption('--key <key>', 'fc_key from https://finchip.ai/a2aentry')
  .option('--chain <chainId>', 'Chain ID or key (56|8453|1|42161|10 / bsc|base|ethereum|arbitrum|optimism)', '56')
  .action(cmdInit);

program
  .command('verify')
  .description('Verify fc_key on-chain + show protocol + V2.5 lock state')
  .option('--key <key>',     'fc_key (uses saved config if omitted)')
  .option('--chain <chainId>', 'Chain ID or key')
  .action(cmdVerify);

program
  .command('register')
  .description('Register fc_key on AgentRegistry (requires wallet)')
  .option('--key <key>',         'fc_key (uses saved config if omitted)')
  .option('--perm <perm>',       'Permission: read|acquire|launch|trade|full|0x0F', 'full')
  .option('--wallet-type <type>','Wallet type: eoa|aa|multisig', 'eoa')
  .option('--label <label>',     'Optional agent label')
  .option('--chain <chainId>',   'Chain ID or key')
  .action(cmdRegister);

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

// ── Operate · market ─────────────────────────────────────────────────────────
const market = program.command('market').description('Browse the chip market');

market
  .command('list')
  .description('List all chips on a chain')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--limit <n>',       'Max chips to show', '20')
  .option('--category <cat>',  'Filter by category')
  .action(cmdMarketList);

market
  .command('search')
  .description('Alias for list with broader default limit')
  .option('--chain <chainId>', 'Chain ID or key')
  .option('--limit <n>',       'Max chips to show', '50')
  .option('--category <cat>',  'Filter by category')
  .action(cmdMarketSearch);

// ── Operate · acquire ────────────────────────────────────────────────────────
program
  .command('acquire')
  .description('Purchase a license (ERC-1155) or fork (ERC-721)')
  .requiredOption('--slug <slug>', 'Chip slug (e.g. audit-pro_finchip)')
  .option('--chain <chainId>',     'Chain ID or key')
  .option('--fork',                'Force ERC-721 path (purchaseFork)')
  .option('--force',               'Acquire even if already holding')
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
  .action(cmdTradeSell);

trade
  .command('cancel')
  .description('Cancel an active listing')
  .requiredOption('--id <id>', 'Listing ID')
  .option('--chain <chainId>', 'Chain ID or key')
  .action(cmdTradeCancel);

// ── Operate · library ────────────────────────────────────────────────────────
program
  .command('library')
  .description('Show all chips you hold across all supported chains')
  .option('--wallet <addr>',   'Wallet address (defaults to one derived from private key)')
  .option('--chain <chainId>', 'Filter to a single chain')
  .action(cmdLibrary);

// ── Configure ────────────────────────────────────────────────────────────────
const config = program.command('config').description('Manage CLI configuration');

config
  .command('get [key]')
  .description('Show config (or a specific key)')
  .action(cmdConfigGet);

config
  .command('set <key> <value>')
  .description('Set a config value')
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
  .action(cmdPay);

// ── Help footer ──────────────────────────────────────────────────────────────
program.addHelpText('after', `
${c.gray}Quick start:${c.reset}
  finchip init --key fc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
  finchip register --perm full
  finchip doctor                       ${c.gray}# full A2A + protocol health check${c.reset}
  finchip market list                  ${c.gray}# browse all chips on default chain${c.reset}
  finchip acquire --slug audit-pro_finchip

${c.gray}Chains:${c.reset}
  --chain 56     ${c.gray}or --chain bsc        (BSC Mainnet,    BNB)${c.reset}
  --chain 8453   ${c.gray}or --chain base       (Base Mainnet,   ETH)${c.reset}
  --chain 1      ${c.gray}or --chain ethereum   (Ethereum,       ETH)${c.reset}
  --chain 42161  ${c.gray}or --chain arbitrum   (Arbitrum One,   ETH)${c.reset}
  --chain 10     ${c.gray}or --chain optimism   (Optimism,       ETH)${c.reset}
  --chain 421614 ${c.gray}or --chain arbsepolia (Arb Sepolia,    ETH) — internal testnet${c.reset}

${c.gray}Docs:${c.reset}    https://finchip.ai/a2aentry
${c.gray}GitHub:${c.reset}  https://github.com/Sleipnirs/finchip-cli
${c.gray}npm:${c.reset}     https://www.npmjs.com/package/finchip-cli
`);

program.parse();
