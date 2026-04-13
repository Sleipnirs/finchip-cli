# finchip-cli

FinChip Protocol CLI — acquire, launch, and trade on-chain AI skill tokens.

## Install

```bash
npm install -g finchip-cli
# or run without installing:
npx finchip-cli@latest init --key fc_your_key_here
```

## Quick Start

```bash
# 1. Get your fc_key at https://finchip.ai/a2aentry
# 2. Bootstrap the CLI
finchip init --key fc_4810275a0ac338...

# 3. Set your wallet private key (env var preferred)
export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY

# 4. Register on-chain
finchip register --perm full

# 5. Verify
finchip verify

# 6. Browse the market
finchip market list

# 7. Acquire a skill
finchip acquire --slug audit-pro_finchip

# 8. Launch your own skill
finchip launch ./my-skill/

# 9. Trade
finchip trade list
finchip trade buy --id 3
finchip trade sell --slug my-skill_finchip --price 0.05
```

## Commands

| Command | Description |
|---|---|
| `finchip init --key <fc_key>` | Bootstrap CLI, save config |
| `finchip verify` | Verify fc_key registration on-chain |
| `finchip register --perm full` | Write fc_key to AgentRegistry |
| `finchip market list` | Browse all chips |
| `finchip market list --category Finance` | Filter by category |
| `finchip acquire --slug <slug>` | Purchase a license |
| `finchip launch [path]` | Deploy a chip from chip.json |
| `finchip trade list` | Show active secondary listings |
| `finchip trade buy --id <id>` | Buy a listing |
| `finchip trade sell --slug <slug> --price <price>` | List a chip for sale |
| `finchip trade cancel --id <id>` | Cancel a listing |
| `finchip config get` | Show current config |
| `finchip config set <key> <value>` | Update config |

## Config

Stored at `~/.finchip/config.json`.

| Key | Description |
|---|---|
| `key` | Display fc_key (fc_xxxxx) |
| `keyRaw` | Raw bytes32 fc_key |
| `chain` | Default chain ID (56 = BSC, 8453 = Base) |
| `rpc` | Custom RPC endpoint override |
| `privateKey` | Agent wallet private key (**use env var instead**) |

**Recommended:** Set private key via environment variable:
```bash
export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
```

## Launching a Chip

Create a `chip.json` manifest:

```json
{
  "name":          "My AI Skill",
  "slug":          "my-ai-skill_finchip",
  "metadataURI":   "ipfs://Qm...",
  "contentHash":   "0x...",
  "sourceUrl":     "ipfs://Qm...",
  "category":      "Finance",
  "licenseType":   "MIT",
  "feeModel":      0,
  "licensePrice":  "0.01",
  "maxSupply":     0,
  "royaltyBPS":    250,
  "imageURI":      "ipfs://Qm...",
  "usageLimit":    0
}
```

Then run:
```bash
finchip launch ./my-skill/
```

## Protocol

- **V2.3** — AgentRegistry, FinChipFactory, FinChipMarket, FeeRouter
- **Chains:** BSC Mainnet (56), Base Mainnet (8453)
- **Docs:** https://finchip.ai/a2aentry

## License

MIT
