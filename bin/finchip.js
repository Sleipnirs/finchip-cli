#!/usr/bin/env node
import { Command } from 'commander';
import { cmdInit }                                          from '../src/commands/init.js';
import { cmdVerify }                                        from '../src/commands/verify.js';
import { cmdRegister }                                      from '../src/commands/register.js';
import { cmdMarketList, cmdMarketSearch }                   from '../src/commands/market.js';
import { cmdAcquire }                                       from '../src/commands/acquire.js';
import { cmdLaunch }                                        from '../src/commands/launch.js';
import { cmdPrepare }                                       from '../src/commands/prepare.js';
import { cmdTradeList, cmdTradeBuy, cmdTradeSell, cmdTradeCancel } from '../src/commands/trade.js';
import { cmdConfigGet, cmdConfigSet, cmdConfigUnset }       from '../src/commands/config.js';
import { c } from '../src/utils.js';

const program = new Command();

program
  .name('finchip')
  .description('FinChip Protocol CLI — acquire, launch, and trade on-chain skill tokens')
  .version('0.1.0');

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Bootstrap CLI with your fc_key')
  .requiredOption('--key <key>', 'fc_key (get from https://finchip.ai/a2aentry)')
  .option('--chain <chainId>', 'Chain ID: 56 (BSC) or 8453 (Base)', '56')
  .action(cmdInit);

// ── verify ───────────────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Verify fc_key registration on-chain')
  .option('--key <key>', 'fc_key (uses saved config if omitted)')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdVerify);

// ── register ─────────────────────────────────────────────────────────────────
program
  .command('register')
  .description('Register fc_key on AgentRegistry (requires wallet)')
  .option('--key <key>', 'fc_key (uses saved config if omitted)')
  .option('--perm <perm>', 'Permission: read|acquire|launch|trade|full', 'full')
  .option('--wallet-type <type>', 'Wallet type: eoa|aa|multisig', 'eoa')
  .option('--label <label>', 'Agent label (optional)')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdRegister);

// ── market ───────────────────────────────────────────────────────────────────
const market = program.command('market').description('Browse the chip market');

market
  .command('list')
  .description('List all available chips')
  .option('--chain <chainId>', 'Chain ID', '56')
  .option('--limit <n>', 'Max chips to show', '20')
  .option('--category <cat>', 'Filter by category')
  .action(cmdMarketList);

market
  .command('search')
  .description('Search chips (alias for list with --category)')
  .option('--chain <chainId>', 'Chain ID', '56')
  .option('--limit <n>', 'Max chips to show', '50')
  .option('--category <cat>', 'Filter by category')
  .action(cmdMarketSearch);

// ── acquire ──────────────────────────────────────────────────────────────────
program
  .command('acquire')
  .description('Purchase a license for a chip')
  .requiredOption('--slug <slug>', 'Chip slug (e.g. audit-pro_finchip)')
  .option('--chain <chainId>', 'Chain ID', '56')
  .option('--force', 'Acquire even if already holding a license')
  .action(cmdAcquire);

// ── launch ───────────────────────────────────────────────────────────────────
program
  .command('launch [path]')
  .description('Deploy a new chip from a chip.json manifest')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdLaunch);

// ── trade ────────────────────────────────────────────────────────────────────
const trade = program.command('trade').description('Secondary market trading');

trade
  .command('list')
  .description('Show active listings')
  .option('--chain <chainId>', 'Chain ID', '56')
  .option('--limit <n>', 'Max listings to show', '20')
  .action(cmdTradeList);

trade
  .command('buy')
  .description('Buy a secondary market listing')
  .requiredOption('--id <id>', 'Listing ID (from trade list)')
  .option('--qty <qty>', 'Quantity to buy', '1')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdTradeBuy);

trade
  .command('sell')
  .description('List a chip token for sale')
  .requiredOption('--slug <slug>', 'Chip slug')
  .requiredOption('--price <price>', 'Price per unit in ETH/BNB')
  .option('--qty <qty>', 'Quantity to list', '1')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdTradeSell);

trade
  .command('cancel')
  .description('Cancel an active listing')
  .requiredOption('--id <id>', 'Listing ID')
  .option('--chain <chainId>', 'Chain ID', '56')
  .action(cmdTradeCancel);

// ── config ───────────────────────────────────────────────────────────────────
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

// ── prepare ──────────────────────────────────────────────────────────────────
program
  .command('prepare <filepath>')
  .description('Full pipeline: encrypt + IPFS + Lit + deploy + setLitData (one command)')
  .option('--name <name>',         'Skill name (default: filename)')
  .option('--slug <slug>',         'Unique slug, must end with _finchip')
  .option('--price <price>',       'License price in ETH/BNB', '0.01')
  .option('--category <category>', 'Skill category (Finance, Code, Data…)', 'General')
  .option('--description <desc>',  'Short description')
  .option('--image-uri <uri>',     'IPFS URI for cover image')
  .option('--max-supply <n>',      'Max licenses (0 = unlimited)', '0')
  .option('--royalty-bps <bps>',   'Royalty basis points (250 = 2.5%)', '250')
  .option('--license-type <type>', 'License type (MIT, Apache, Commercial)', 'MIT')
  .option('--encrypt <mode>',      'Encryption: finchip (default) | lit | agent', 'finchip')
  .option('--chain <chainId>',     'Chain ID: 56 (BSC) or 8453 (Base)', '56')
  .action(cmdPrepare);

// ── help footer ───────────────────────────────────────────────────────────────
program.addHelpText('after', `
${c.gray}Examples:${c.reset}
  finchip init --key fc_4810275a0ac3380672ebe60cec208839
  finchip register --perm full
  finchip verify
  finchip market list --chain 8453
  finchip acquire --slug audit-pro_finchip
  finchip launch ./my-skill/
  finchip trade list
  finchip trade buy --id 3 --qty 1
  finchip trade sell --slug my-skill_finchip --price 0.05
  export FINCHIP_PRIVATE_KEY=0xYOUR_KEY

${c.gray}Docs:${c.reset}  https://finchip.ai/a2aentry
${c.gray}Chain IDs:${c.reset} 56 = BSC Mainnet · 8453 = Base Mainnet
`);

program.parse();
