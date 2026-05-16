# finchip-cli

**FinChip Protocol CLI — A2A-native client for on-chain AI skill tokens.**

[![npm](https://img.shields.io/npm/v/finchip-cli)](https://www.npmjs.com/package/finchip-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

AI agents acquire, launch, and trade skill tokens on the FinChip Protocol — directly from the terminal, across **5 EVM mainnets**, with full **ERC-1155 + ERC-721 fork** support, **A2A Protocol Stack** integration, and a **Coinbase x402** client built in.

---

## What's new in v0.3.0

> v0.2.x was a V2.3-era stub. v0.3.0 is a ground-up rewrite for V2.4/V2.5.

- ✨ **5-chain support** — BSC · Base · Ethereum · Arbitrum · Optimism
- ✨ **Dynamic discovery** — only AgentRegistry is hardcoded; all other addresses are resolved at runtime via `AgentRegistry.getProtocolExtended()`. Future protocol upgrades require **zero CLI changes**.
- ✨ **ERC-721 fork chips** — `purchaseFork`, `deployChip721`, fork-aware `prepare`/`acquire`/`launch`/`trade`
- ✨ **A2A Protocol Stack integration** — CLI reads `finchip.ai/.well-known/*` and `/openapi.json`, mirrors the same 5 services declared in `acp.json`, and ships a working **x402 client** (`finchip pay`) that consumes 402 challenges
- ✨ **Three new commands** — `doctor` (full health check), `protocol info` (state per chain), `chains` (list all), `library` (cross-chain holdings), `pay` (x402)
- 🛠 Bug fixes:
  - `prepare` `require('path')` in ESM → broken in v0.2.x, now uses native ESM import
  - `launch` event parsing was ASCII-hex of the event *name* → now uses `keccak256(eventSig)` via viem `decodeEventLog`
  - `trade sell` needed `setApprovalForAll` but it was missing from CHIP_ABI → added
  - Version mismatch (`bin/finchip.js` said `0.1.0`, package.json said `0.2.0`) → both now read from `package.json`

---

## Install

```bash
# One-line installer (Linux / macOS) — installs Node 20 LTS if needed
curl -fsSL https://finchip.ai/install.sh | bash -s -- --key fc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Windows PowerShell
$env:FC_KEY="fc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
irm https://finchip.ai/install.ps1 | iex

# npm (cross-platform)
npm install -g finchip-cli
# or run without installing
npx finchip-cli@latest init --key fc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Get your `fc_xxxxx` key at **https://finchip.ai/a2aentry**.

---

## Quick start

```bash
# 1. Bootstrap with your fc_key
finchip init --key fc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 2. Set wallet (env var preferred over saving to disk)
export FINCHIP_PRIVATE_KEY=0xYOUR_PRIVATE_KEY

# 3. Register fc_key on-chain (once)
finchip register --perm full

# 4. Full health check — confirms 5 chains + A2A endpoints + on-chain state
finchip doctor

# 5. Browse and operate
finchip market list                              # default chain (BSC)
finchip market list --chain base                 # by chain key
finchip acquire --slug audit-pro_finchip
finchip launch ./my-skill/
finchip trade list
finchip library                                  # see what you hold

# 6. Pay an x402-protected URL
finchip pay https://finchip.ai/api/v1 --dry-run
```

---

## Commands

### Bootstrap

| Command | Description |
|---|---|
| `finchip init --key <fc_key>` | Save config, verify key on-chain |
| `finchip verify` | Confirm registration + show protocol + V2.5 lock state |
| `finchip register --perm full` | Write fc_key to AgentRegistry |

### Market & catalog

| Command | Description |
|---|---|
| `finchip market list [--chain X] [--category C]` | List all chips on a chain |
| `finchip market search --category Finance` | Same as list, broader default limit |
| `finchip library [--wallet 0x... \| --chain X]` | Cross-chain holdings |

### Acquire & launch

| Command | Description |
|---|---|
| `finchip acquire --slug <s>` | Buy an ERC-1155 license (auto-detect; or `--fork` for ERC-721) |
| `finchip launch <path>` | Deploy from `chip.json` (set `"standard": "ERC721"` or pass `--standard ERC721`) |
| `finchip prepare <file> --slug <s> [--fork]` | Full pipeline: encrypt → IPFS → deploy → setLitData → register-chip |

### Trade

| Command | Description |
|---|---|
| `finchip trade list` | Active secondary listings |
| `finchip trade buy --id <id>` | Buy a listing |
| `finchip trade sell --slug <s> --price <p>` | List ERC-1155 |
| `finchip trade sell --slug <s> --price <p> --fork --token-id <id>` | List ERC-721 |
| `finchip trade cancel --id <id>` | Cancel listing |

### Inspect

| Command | Description |
|---|---|
| `finchip doctor [-v]` | 3-layer health check: hardcoded / A2A / on-chain + drift detection |
| `finchip protocol [--chain X]` | Full protocol state for a chain + A2A endpoint surface |
| `finchip chains` | List 5 supported chains + AgentRegistry addresses |

### Configure

| Command | Description |
|---|---|
| `finchip config get [key]` | Show config (sensitive keys masked) |
| `finchip config set <key> <value>` | Update a config value |
| `finchip config unset <key>` | Remove a config value |

### Commerce (x402)

| Command | Description |
|---|---|
| `finchip pay <url> [--dry-run]` | Consume an HTTP 402 challenge; signs EIP-3009 USDC auth (no gas needed) |

---

## ERC-721 fork chips

V2.4 introduced **fork chips** — ERC-721 NFTs where each fork is a unique tokenized branch of the parent skill. Use the same CLI commands; pass `--fork` (or set `"standard": "ERC721"` in chip.json).

```bash
# Launch a fork chip
finchip prepare ./my-skill.js \
  --slug my-skill_finchip --fork \
  --price 0.05 --max-forks 100

# Acquire a fork
finchip acquire --slug my-skill_finchip --fork

# List a fork for sale (need --token-id since each fork is unique)
finchip trade sell --slug my-skill_finchip --fork --token-id 7 --price 0.10
```

---

## A2A Protocol Stack integration

FinChip publishes a full **Level 5 "Agent-Native"** A2A protocol stack at `finchip.ai/.well-known/*` and `finchip.ai/openapi.json` + `/api/v1`. The CLI is the terminal-side counterpart:

| A2A surface | CLI counterpart |
|---|---|
| `acp.json` declares 5 services (discovery, acquire, launch, trade, library) | `finchip market`, `acquire`, `launch`, `trade`, `library` |
| `mcp.json` declares 6 tools | All exposed as CLI commands |
| `ucp` declares 3 services + `chains` | `finchip chains`, `finchip protocol` |
| `agent-card.json` declares contract addresses | `finchip doctor` cross-checks against on-chain |
| `/api/v1` returns x402 challenge | `finchip pay` consumes it |
| `/api/get-key`, `/api/lit-encrypt`, `/api/register-chip` | `finchip prepare` calls all three |

Run `finchip doctor` to see all 21 endpoints health-checked in one go.

---

## x402 client

Consumes Coinbase x402 v1 payment challenges. The CLI signs an EIP-3009 `TransferWithAuthorization` on USDC; **no gas needed from the client** (the server submits the authorization).

```bash
# Dry run — inspect what would be paid
finchip pay https://finchip.ai/api/v1 --dry-run

# Live — sign + retry with X-Payment header
finchip pay https://finchip.ai/api/v1
```

The CLI auto-picks the chain where your wallet has sufficient USDC balance. Supported networks (Coinbase x402 canonical names): `base`, `ethereum`, `arbitrum`, `optimism`, `bnb`.

---

## Chains

| `--chain` value | Chain ID | Symbol |
|---|---|---|
| `bsc` | 56 | BNB |
| `base` | 8453 | ETH |
| `ethereum` | 1 | ETH |
| `arbitrum` | 42161 | ETH |
| `optimism` | 10 | ETH |

Default: BSC (`--chain 56`). Set a different default with `finchip config set chain base`.

---

## Permissions

| Flag | Value | Allows |
|---|---|---|
| `--perm read` | 0x01 | Read market / chip info |
| `--perm acquire` | 0x02 | `purchaseLicense` / `purchaseFork` |
| `--perm launch` | 0x04 | `deployChip` / `deployChip721` |
| `--perm trade` | 0x08 | `listToken` / `buyListing` |
| `--perm full` | 0x0F | All of the above |

You can also pass numeric: `--perm 0x06` (acquire + launch only).

---

## Config (`~/.finchip/config.json`)

| Key | Description |
|---|---|
| `key` | fc_key (display: `fc_xxxxx`) |
| `keyRaw` | bytes32 raw key |
| `chain` | Default chain ID |
| `rpc` | Custom RPC override (optional) |
| `privateKey` | ⚠ Use `FINCHIP_PRIVATE_KEY` env var instead |
| `pinataJwt` | ⚠ Use `PINATA_JWT` env var instead |

---

## Chip manifest (`chip.json` for `finchip launch`)

```json
{
  "name":         "My AI Skill",
  "slug":         "my-ai-skill_finchip",
  "standard":     "ERC1155",
  "metadataURI":  "ipfs://Qm...",
  "contentHash":  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "sourceUrl":    "ipfs://Qm...",
  "category":     "Finance",
  "licenseType":  "MIT",
  "feeModel":     0,
  "licensePrice": "0.01",
  "maxSupply":    0,
  "royaltyBPS":   250,
  "imageURI":     "",
  "usageLimit":   0
}
```

For ERC-721 fork chips, set `"standard": "ERC721"`, replace `licensePrice`/`maxSupply` with `forkPrice`/`maxForks`, and omit `feeModel`/`usageLimit`.

---

## Protocol versions

The CLI works with **FinChip Protocol V2.4 / V2.5** (current). It uses `AgentRegistry.getProtocolExtended()` to discover all 5 dependent contracts (ChipRegistry, Factory, Market, FeeRouter, ERC-1155 Deployer, ERC-721 Deployer) at runtime — so when V2.6+ contracts are deployed, the CLI auto-discovers them without any code update.

---

## Migration from v0.2.x

If you have an existing `~/.finchip/config.json`, it should continue to work — v0.3.0 reads all the same keys.

Behavioural changes:
- The `--chain` flag now accepts strings (`bsc`, `base`, etc.) in addition to numeric IDs
- `finchip launch` now auto-detects which event was emitted (no more silent failures from the old broken parser)
- `finchip trade sell` now correctly approves the market before listing (previously crashed for unapproved sellers)
- `finchip prepare` no longer crashes on `require('path')` — uses native ESM imports

---

## Links

- 🌐 A2A entry page (Agent bootstrap): https://finchip.ai/a2aentry
- 📦 npm: https://www.npmjs.com/package/finchip-cli
- 💻 GitHub: https://github.com/Sleipnirs/finchip-cli
- 📋 Pinata (for `prepare`): https://app.pinata.cloud/keys

---

## License

MIT
