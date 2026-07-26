# finchip-cli

FinChip Protocol 的 Agent CLI：登录 FinChip 账号、浏览与购买 Chip、发布和下载加密 Skill、管理价格、查看持仓和使用 A2A/x402 接口。

当前支持 BSC、Base、Ethereum、Arbitrum、Optimism，以及内部测试用的 Arbitrum Sepolia。CLI 可以查询和交易 ERC-1155 与 ERC-721；新建发布目前只创建 ERC-1155。

## 安装

```bash
npm install -g finchip-cli
finchip --help
```

也可以直接运行：

```bash
npx finchip-cli@latest --help
```

## 登录与钱包

CLI 使用配置的钱包在本地签署一次短期挑战，再保存 Site 返回的 session cookie。Cookie 按 `FINCHIP_API_URL` 隔离并写入仅当前用户可读的 `~/.finchip/credentials.json`；命令输出不会包含 cookie、签名或私钥。

```bash
finchip login
finchip status --json
finchip logout
```

运行前请把实际钱包私钥放入 `FINCHIP_PRIVATE_KEY` 环境变量。发布和 creator 管理需要登录。加密下载需要私钥签署持币验证；明文下载在有效登录 cookie 可完成授权时不强制要求私钥。链上交易还需要同一个钱包的私钥；浏览 market 等只读命令不需要登录。

`fc_key` 仍用于 AgentRegistry 的 Agent 权限流程：

从 `https://finchip.ai/a2aentry` 获取实际 fc_key 后运行 `finchip init --key`，再通过 `finchip register --perm full` 注册并用 `finchip verify` 检查。

它不是 `skill publish` 的 Site 登录凭据。

## 发布加密 Skill

完整发布入口只有：

```bash
finchip skill publish ./my-skill \
  --slug my-skill \
  --name "My Skill" \
  --description "Agent-ready skill description" \
  --category "Dev Environment" \
  --price 0.01 \
  --chain bsc
```

新发布必须显式填写 `--category`，避免未填写的内容被静默归入错误分类。`--license`、`--version`、`--royalty-bps` 和 `--max-supply` 有平台默认值。

### 加密方式

| `--encrypt` | 行为 |
|---|---|
| `finchip` | 平台默认；Site 返回派生 KEK，CLI 在本地包裹 CK 的 Base64 文本 |
| `oracle-v2` | Site 返回 Oracle V2 KEK，CLI 在本地包裹 raw 32-byte CK |
| `lit` | Site 将 raw CK 的 Base64 形式转交 Lit/Chipotle，取得 Lit envelope |

未写 `--encrypt` 时使用 `finchip`。

安全差异：`finchip` 和 `oracle-v2` 都在 CLI 本地包裹内容密钥；`lit` 必须把 raw CK 的 Base64 表示发送给 FinChip Site，再由 Site 转交 Lit/Chipotle。CLI 会在执行前显示这一提示。由于 Site 尚未显式映射 Arbitrum Sepolia，且该链上的完整 Chipotle 发布/解密流程尚未验证，`421614 + lit` 会在上传前被拒绝。

### Dry run 与恢复

```bash
finchip skill publish ./my-skill \
  --slug my-skill \
  --name "My Skill" \
  --description "Agent-ready skill description" \
  --category "Dev Environment" \
  --price 0.01 \
  --encrypt oracle-v2 \
  --dry-run --json

finchip skill publish --resume my-skill --json
```

目录发布要求目标是 Git 仓库，并遵守 `.gitignore`。CLI 还会强制排除常见凭据、私钥、云服务配置、容器/Kubernetes 认证文件和 Terraform state/variables。Dry run JSON 会返回 `sourceFiles`、`excludedSensitiveFiles` 和实际 `encryptionMode`。

发布恢复状态保存在 `~/.finchip/publish-state.json`，权限仅限当前用户。状态会在广播前保存待提交的完整 encryption tuple；因此 Lit 在 `key_prepared` 或 `key_submitted` 后恢复时会复用 ciphertext，不再次发送 CK。旧状态没有模式时按 `finchip` 解释。

`finchip publish` 仍是隐藏的兼容别名，行为与 `finchip skill publish` 相同。旧的 `finchip prepare` 和独立 `finchip launch` 已禁用；直接调用会返回 `COMMAND_DEPRECATED`，且不会访问网络、钱包或 IPFS。

## 下载与解密

`download` 只保存原始文件或 ZIP，不解压、不安装、不执行：

```bash
finchip download my-skill_finchip
finchip download my-skill_finchip --dir ./downloads --json
finchip download my-skill_finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --no-provenance
```

未指定部署时，CLI 从 Site 获取 canonical chain 和 Chip 地址。指定部署时，`--chain` 与 `--addr` 必须一起使用。下载默认拒绝覆盖已有文件；只有显式使用 `--force` 才会覆盖。

CLI 先使用当前 Site session cookie 请求 source manifest；Site 要求额外钱包证明时，再生成一次 `skill_detail_viewer` 签名。Cookie 钱包与 `FINCHIP_PRIVATE_KEY` 钱包不一致会立即停止。授权下载 URL 必须与 `FINCHIP_API_URL` 同源，避免 cookie 或下载 token 被发送给第三方。

支持 Site 当前四种来源：

| Source kind | 校验强度 |
|---|---|
| `ipfs_manifest_v1` | 校验链上 manifest hash、encrypted package hash 和解密后的 plaintext hash |
| `ipfs_encrypted` | 兼容旧式直接 `.enc`；只有 AES-GCM authentication tag，没有独立 expected hash |
| `ipfs_plain` | 依赖 Site 授权和 HTTPS 传输，不提供链上内容 hash |
| `github` | 保存 Site 生成的 scoped repository archive，不提供链上内容 hash |

因此四类下载的完整性保证并不相同。JSON 中的 `integrityLevel` 会分别返回 `manifest-and-artifact-hashes`、`aead-only` 或 `transport-only`；没有独立 plaintext hash 时，`verifiedPlaintextSha256` 必须为 `null`。

`FINCHIP_V2`、`LIT_V1` 和 `FINCHIP_V2_ORACLE` 都可按链上 marker 解密。Oracle V2 每次请求生成新的 nonce、签名和不可导出的临时 P-256 私钥；challenge 过期只会用全新材料自动重试一次，同一个签名绝不重发。`SEAL_REPLAY` 被当作安全信号硬停止，而不是普通网络错误。

Oracle V2 的普通 ZIP 默认会在 plaintext hash 校验成功后加入 `.finchip-provenance.json`。这会有意改变落盘文件的字节，因此：

- `verifiedPlaintextSha256` 是注入前、与 manifest 对齐的明文 hash。
- `outputSha256` 是实际保存文件的 hash。
- 两者不同不表示文件损坏。
- `--no-provenance` 会跳过注入，保存字节级原始明文。

非 ZIP、EPUB、signed JAR、没有可验证 plaintext hash 的旧式来源或无法安全重打包的 ZIP 不会注入 provenance。

## 搜索 Skill

```bash
finchip skill search "security audit"
finchip skill search agent --category "Dev Environment" --sort rating --curated
finchip skill search wallet --limit 20 --offset 20 --json
```

`skill search` 使用 Site 的公开索引搜索已经部署、可交易的 Web3 Skill；它不需要登录、钱包、私钥、FC key 或 RPC。当前不开放 Web2 Skill 和 `--source` 参数。

`/api/skills` 是 CDN 公共缓存端点。CLI 刻意不在搜索请求中附带 Cookie、Authorization、Origin 或任何本地身份信息，避免凭据进入公共缓存路径后造成串号或缓存污染。搜索结果保持 Site 返回的排序和分页值，不在本地缓存、重排或二次过滤。

查询长度为 1–64 个字符。多词查询中，Site 使用前四个 token 生成分词匹配变体，同时仍使用完整查询短语进行匹配；CLI 不截断或改写用户输入。默认按下载量排序并返回 20 条，使用 `--offset` 翻页。

`finchip market search` 是早期保留的链上 registry 列表别名，不是全文搜索；需要按标题、简介、作者、slug、分类或标签搜索时应使用 `finchip skill search`。

## Skill 管理

```bash
finchip skill get my-skill_finchip --chain bsc --addr 0x1111111111111111111111111111111111111111

finchip skill price set my-skill_finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --price 0.02

finchip skill price sync my-skill_finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --tx-hash 0xabababababababababababababababababababababababababababababababab
```

CLI 暂不创建 ERC-721 Chip，但已有 ERC-721 的查询、购买、持仓和二级市场操作继续支持。

## 市场、购买与持仓

```bash
finchip market list --chain bsc
finchip market search --chain base --category "Dev Environment"
finchip acquire --slug audit-pro_finchip --chain bsc
finchip library
finchip library --chain bsc
```

Market 会通过 ERC-165 区分 ERC-1155 与 ERC-721。ERC-721 使用 `forkPrice / totalForked / maxForks`，不会按 ERC-1155 getter 读取。

二级市场：

```bash
finchip trade list --chain bsc
finchip trade buy --id 1 --chain bsc
finchip trade sell --slug audit-pro_finchip --price 0.02 --chain bsc
finchip trade sell --slug forkable_finchip --fork --token-id 7 --price 0.10 --chain bsc
finchip trade cancel --id 1 --chain bsc
```

## 链与协议检查

`--chain` 接受 chain key 或 chain ID：

| Key | Chain ID | Network |
|---|---:|---|
| `bsc` | 56 | BNB Smart Chain |
| `base` | 8453 | Base |
| `ethereum` | 1 | Ethereum |
| `arbitrum` | 42161 | Arbitrum One |
| `optimism` | 10 | Optimism |
| `arbsepolia` | 421614 | Arbitrum Sepolia（内部测试） |

```bash
finchip chains
finchip protocol --chain bsc
finchip doctor --verbose
```

AgentRegistry 地址是 CLI 的链级入口；Factory、ChipRegistry、Market、FeeRouter 和 deployer 地址均通过 `getProtocolExtended()` 动态发现。

## A2A 与 x402

CLI 会读取 Site 发布的 `/.well-known/*`、`/openapi.json` 和 `/api/v1`：

```bash
finchip doctor
finchip pay https://finchip.ai/api/v1 --dry-run
```

`doctor` 检查 endpoint discovery 与链上协议状态；`protocol` 展示具体链的协议地址。`pay` 消费 x402 challenge 并签署 EIP-3009 USDC authorization。

## 配置

```bash
finchip config get
finchip config set chain base
finchip config unset rpc
```

优先通过 `FINCHIP_PRIVATE_KEY` 环境变量提供实际私钥，不要把私钥写入脚本或文档。

历史配置中的 `pinataJwt` 不再被发布流程使用，但仍始终作为敏感字段遮罩，避免旧 secret 被 `config get` 输出。

## 主要命令

| Command | Purpose |
|---|---|
| `finchip login/status/logout` | Site 钱包账号 session |
| `finchip init/register/verify` | fc_key 与 AgentRegistry 权限 |
| `finchip skill publish` | 唯一完整加密发布入口 |
| `finchip download` | 授权下载并解密；不安装、不执行 |
| `finchip skill search` | 搜索 Site 索引中的 Web3 Skill |
| `finchip skill get/price` | Creator 管理 |
| `finchip market list/search` | 直接浏览链上 ERC-1155/721 registry |
| `finchip acquire` | 购买 license 或 fork |
| `finchip library` | 按钱包查看持仓 |
| `finchip trade` | 二级市场 |
| `finchip chains/protocol/doctor` | 链与 A2A 检查 |
| `finchip pay` | x402 client |

## 开发验证

```bash
npm install
npm test
npm pack --dry-run
```

本地测试不会默认执行真实 Site 发布、Oracle grant、下载或链上写入。

## Links

- Site: https://finchip.ai
- A2A entry: https://finchip.ai/a2aentry
- GitHub: https://github.com/Sleipnirs/finchip-cli
- npm: https://www.npmjs.com/package/finchip-cli

## License

MIT
