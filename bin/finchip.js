#!/usr/bin/env node
// FinChip CLI v0.3.0 — entry point
//
// Commands:
//   Bootstrap    — init, verify, register
//   Operate      — market, acquire, launch, prepare, trade, library
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
import { cmdLaunch }                                        from '../src/commands/launch.js';
import { cmdPrepare }                                       from '../src/commands/prepare.js';
import { cmdTradeList, cmdTradeBuy, cmdTradeSell, cmdTradeCancel } from '../src/commands/trade.js';
import { cmdConfigGet, cmdConfigSet, cmdConfigUnset }       from '../src/commands/config.js';
import { cmdLibrary }                                       from '../src/commands/library.js';
import { cmdProtocolInfo }                                  from '../src/commands/protocol.js';
import { cmdChains }                                        from '../src/commands/chains.js';
import { cmdDoctor }                                        from '../src/commands/doctor.js';
import { cmdPay }                                           from '../src/commands/pay.js';
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

// ── Operate · launch ─────────────────────────────────────────────────────────
program
  .command('launch [path]')
  .description('Deploy a new chip from chip.json manifest (ERC-1155 or ERC-721)')
  .option('--chain <chainId>',  'Chain ID or key')
  .option('--standard <std>',   'Override standard: ERC1155 (default) or ERC721')
  .action(cmdLaunch);

// ── Operate · prepare ────────────────────────────────────────────────────────
program
  .command('prepare <filepath>')
  .description('Full pipeline: encrypt + IPFS + deploy + setLitData + register-chip')
  .option('--name <name>',          'Skill name (default: filename)')
  .option('--slug <slug>',          'Unique slug, must end with _finchip')
  .option('--price <price>',        'Price (license or fork) in native currency', '0.01')
  .option('--category <category>',  'Category (Finance, Code, Data…)', 'General')
  .option('--description <desc>',   'Short description')
  .option('--image-uri <uri>',      'IPFS URI for cover image')
  .option('--max-supply <n>',       'ERC-1155: max licenses (0 = unlimited)', '0')
  .option('--max-forks <n>',        'ERC-721: max forks (0 = unlimited)', '0')
  .option('--royalty-bps <bps>',    'Royalty basis points (250 = 2.5%)', '250')
  .option('--license-type <type>',  'License (MIT, Apache, Commercial)', 'MIT')
  .option('--encrypt <mode>',       'Encryption: finchip | lit | agent', 'finchip')
  .option('--standard <std>',       'ERC1155 (default) or ERC721')
  .option('--fork',                 'Shortcut for --standard ERC721')
  .option('--chain <chainId>',      'Chain ID or key', '56')
  .action(cmdPrepare);

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
  .description('Show all chips you hold across all 5 chains')
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

${c.gray}5-chain support:${c.reset}
  --chain 56     ${c.gray}or --chain bsc       (BSC Mainnet,    BNB)${c.reset}
  --chain 8453   ${c.gray}or --chain base      (Base Mainnet,   ETH)${c.reset}
  --chain 1      ${c.gray}or --chain ethereum  (Ethereum,       ETH)${c.reset}
  --chain 42161  ${c.gray}or --chain arbitrum  (Arbitrum One,   ETH)${c.reset}
  --chain 10     ${c.gray}or --chain optimism  (Optimism,       ETH)${c.reset}

${c.gray}Docs:${c.reset}    https://finchip.ai/a2aentry
${c.gray}GitHub:${c.reset}  https://github.com/Sleipnirs/finchip-cli
${c.gray}npm:${c.reset}     https://www.npmjs.com/package/finchip-cli
`);

program.parse();
