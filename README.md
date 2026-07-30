# finchip-cli

FinChip Protocol 的 Agent CLI：登录 FinChip 账号、浏览与购买 Chip、发布和下载加密 Skill、管理价格、查看持仓和使用 A2A/x402 接口。

当前支持 BSC、Base、Ethereum、Arbitrum、Optimism，以及内部测试用的 Arbitrum Sepolia。CLI 可以查询和交易 ERC-1155 与 ERC-721；新建发布目前只创建 ERC-1155。

## 安装

需要 Node.js 22 或更高版本。CLI 启动时会检查实际 Node 版本；低版本即使被 npm 安装成功，也会在加载命令和加密模块前给出明确错误并退出。

```bash
npm install -g finchip-cli
finchip --help
```

也可以直接运行：

```bash
npx finchip-cli@latest --help
```

## 登录与钱包

钱包 key file 是一个**未加密的明文私钥文件**，不是密码保险箱。请只为 Agent
创建低余额专用钱包，不要使用个人钱包或 treasury 钱包。CLI 不提供备份或恢复；
文件丢失就意味着钱包控制权丢失。

CLI 使用配置的钱包在本地签署一次短期挑战，再保存 Site 返回的 session cookie。Cookie 按 `FINCHIP_API_URL` 隔离并写入仅当前用户可读的 `~/.finchip/credentials.json`；命令输出不会包含 cookie、签名或私钥。

```bash
finchip wallet create
finchip wallet status --json
finchip login
finchip status --json
finchip logout
```

`wallet create` 默认把新钱包写入 `~/.finchip/wallets/agent.key`，使用操作系统的独占创建保证绝不覆盖已有钱包，并把 CLI 自建文件限制为仅当前用户可读。目标已存在时请继续使用原钱包，或显式指定新文件：

```bash
finchip wallet use --file ~/.finchip/wallets/agent.key
finchip wallet create --file ~/.finchip/wallets/agent-2.key
```

`wallet use` 会验证并记录用户提供文件的绝对路径，不复制文件，也不修改该文件或父目录的权限；若当前登录属于另一钱包，还会自动注销旧 session。私钥文件接受带或不带 `0x` 的 64 位十六进制内容。CLI 只把地址、签名和交易发送给 Site，不发送私钥。

钱包只使用 config 中经 `wallet use` 验证的 key-file 路径；历史
`config.privateKey` 仅保留迁移兼容。`FINCHIP_PRIVATE_KEY` 和
`FINCHIP_PRIVATE_KEY_FILE` 已弃用且不再作为私钥来源。登录或签名命令发现任意
非空旧变量时会返回 `WALLET_ENV_DISABLED`，明确要求从当前环境清除，避免临时
覆盖造成签名钱包与登录账号分裂。历史明文配置可运行：

```bash
finchip wallet migrate
```

迁移只是从当前 config 中移除明文，不会安全擦除磁盘历史、编辑器备份、云同步或既往备份。有实际资产的钱包应把旧明文视为可能暴露，并考虑换用新钱包。

发布和 creator 管理需要登录。加密下载需要钱包签署持币验证；明文下载在有效登录 cookie 可完成授权时不强制要求钱包。链上交易还需要同一个钱包；浏览 market 等只读命令不需要登录。

`fc_key` 仍用于 AgentRegistry 的 Agent 权限流程：

从 `https://finchip.ai/a2aentry` 获取实际 fc_key 后运行 `finchip init --key`，再通过 `finchip register --perm full --yes` 注册并用 `finchip verify` 检查。

它不是 `skill publish` 的 Site 登录凭据。

## Agent 安全契约

CLI 把“准备操作”和“授权花钱/广播”分开。会签署付款或广播链上交易的命令必须显式提供 `--yes`；缺少确认时会在外部写入前停止。支持 `--dry-run` 的命令用它完成只读预检，`--yes` 不等于跳过参数、权限、余额、模拟或持仓校验。

`acquire` 还接受可选的 `--max-price` 和 `--max-gas-fee`（均为所选链的原生币数量）。任一链上精确值超过上限都会返回 `ACQUIRE_BUDGET_EXCEEDED`，且不广播。广播结果不确定的现代交易流程会返回 tx hash，不会自动重发。只读命令、登录/登出和普通可回读的 Manage 更新不会为了形式统一而强制增加 `--yes`。

## 发布加密 Skill

完整发布入口只有：

```bash
finchip skill publish ./my-skill \
  --slug my-skill \
  --name "My Skill" \
  --summary "Explains EVM transactions and flags the main risks; it does not sign or broadcast transactions." \
  --description "Problem: Raw EVM transaction data is difficult to assess. Outcome: A structured explanation and risk notes. Can: Decode calls and explain likely effects. Not for: Signing, broadcasting, or guaranteeing safety. Requires: Transaction data and chain context. Produces: A human-readable report. Limits: Results depend on supplied data and supported ABIs. Side effects: None. Good matches: Users reviewing a transaction before signing. Not a match: Users asking the Skill to execute the transaction." \
  --category "Dev Environment" \
  --skill-version "1.0.0" \
  --price 0.01 \
  --chain bsc \
  --yes
```

新发布必须显式填写 `--summary`、`--description` 和 `--category`。`--summary` 最多 280 个字符，用于快速说明问题、结果和主要边界。`--description` 是完整的能力适配契约，应说明解决的问题、产出、能做与不能做、所需输入或权限、限制、副作用，以及适合和不适合的需求，便于 Agent 搜索后判断是否匹配。它是发布者声明，不是 FinChip 对能力或安全性的认证。

`--license`、`--skill-version`、`--royalty-bps` 和 `--max-supply` 有平台默认值。Skill 包版本必须使用 `--skill-version`；根命令的 `finchip --version` 只显示 CLI 版本。

CLI 对外统一显示并接受 Site canonical slug，例如 `my-skill-finchip`。现有链上 Registry 的技术 slug 仍是 `my-skill_finchip`；CLI 会在链上查询时自动转换，历史 `_finchip` 输入也继续兼容。Publish JSON 的 `slug` 是 Site canonical slug，`onchainSlug` 用于链上诊断和恢复，不需要用户日常记忆。

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
  --summary "Explains EVM transactions and flags the main risks; it does not sign or broadcast transactions." \
  --description "Problem: Raw EVM transaction data is difficult to assess. Outcome: A structured explanation and risk notes. Can: Decode calls and explain likely effects. Not for: Signing, broadcasting, or guaranteeing safety. Requires: Transaction data and chain context. Produces: A human-readable report. Limits: Results depend on supplied data and supported ABIs. Side effects: None. Good matches: Users reviewing a transaction before signing. Not a match: Users asking the Skill to execute the transaction." \
  --category "Dev Environment" \
  --skill-version "1.0.0" \
  --price 0.01 \
  --encrypt oracle-v2 \
  --dry-run --json

finchip skill publish --resume my-skill --yes --json
```

目录发布不再要求 Git。若目标位于 Git 仓库中，CLI 使用 Git 枚举文件并遵守 `.gitignore`；普通目录则使用安全的本地递归收集。两种模式都不会跟随符号链接，并强制排除常见凭据、私钥、云服务配置、容器/Kubernetes 认证文件；普通目录还会跳过 `node_modules`、构建输出和常见缓存目录。Dry run JSON 会返回 `sourceFiles`、带原因的 `excludedFiles`、兼容字段 `excludedSensitiveFiles`、`sourceCollectionMode` 和实际 `encryptionMode`。

发布恢复状态保存在 `~/.finchip/publish-state.json`，权限仅限当前用户。状态会在广播前保存待提交的完整 encryption tuple；因此 Lit 在 `key_prepared` 或 `key_submitted` 后恢复时会复用 ciphertext，不再次发送 CK。旧状态没有模式时按 `finchip` 解释。

`finchip publish` 仍是隐藏的兼容别名，行为与 `finchip skill publish` 相同。旧的 `finchip prepare` 和独立 `finchip launch` 已禁用；直接调用会返回 `COMMAND_DEPRECATED`，且不会访问网络、钱包或 IPFS。

## 下载与解密

`download` 只保存原始文件或 ZIP，不解压、不安装、不执行：

```bash
finchip download my-skill-finchip
finchip download my-skill-finchip --dir ./downloads --json
finchip download my-skill-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --no-provenance
```

未指定部署时，CLI 从 Site 获取 canonical chain 和 Chip 地址。指定部署时，`--chain` 与 `--addr` 必须一起使用。下载默认拒绝覆盖已有文件；只有显式使用 `--force` 才会覆盖。

CLI 先使用当前 Site session cookie 请求 source manifest；Site 要求额外钱包证明时，再生成一次 `skill_detail_viewer` 签名。Cookie 钱包与配置的 Agent 钱包不一致会立即停止。授权下载 URL 必须与 `FINCHIP_API_URL` 同源，避免 cookie 或下载 token 被发送给第三方。

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

## 浏览与搜索 Skill

```bash
finchip skill list
finchip skill list --category "Security Audit" --sort new
finchip skill list --category "Dev Environment" --limit 20 --offset 20 --json
finchip skill search "security audit"
finchip skill search agent --category "Dev Environment" --sort rating --curated
finchip skill search wallet --limit 20 --offset 20 --json
```

`skill list` 浏览 Site 目录中的全部 Web3 Skill，也可以只按分类筛选；`skill search` 在同一目录中执行关键词搜索。两者只返回已经部署、活跃且可交易的 Web3 Skill，不需要登录、钱包、私钥、FC key 或 RPC。当前不开放 Web2 Skill 和 `--source` 参数。

`/api/skills` 是 CDN 公共缓存端点。CLI 刻意不在目录和搜索请求中附带 Cookie、Authorization、Origin 或任何本地身份信息，避免凭据进入公共缓存路径后造成串号或缓存污染。结果保持 Site 返回的排序和分页值，不在本地缓存、重排或二次过滤。

`skill search` 的查询长度为 1–64 个字符。多词查询中，Site 使用前四个 token 生成分词匹配变体，同时仍使用完整查询短语进行匹配；CLI 不截断或改写用户输入。两个命令都默认按下载量排序并返回 20 条，使用 `--offset` 翻页。

`finchip market search` 是早期保留的链上 registry 列表别名，不是 Site 目录浏览或全文搜索；浏览目录应使用 `finchip skill list`，按标题、简介、作者、slug、分类或标签搜索时应使用 `finchip skill search`。

## 查看、购买与下载 Skill

消费者的完整只读到持有流程是：

```bash
finchip skill list --category "Security Audit"
finchip skill search "security audit"
finchip skill show audit-pro-finchip
finchip acquire --slug audit-pro-finchip --dry-run
finchip acquire --slug audit-pro-finchip --yes
finchip acquire --slug audit-pro-finchip --max-price 0.01 --max-gas-fee 0.001 --yes
finchip download audit-pro-finchip
finchip skill review list audit-pro-finchip
```

`skill show` 调用公开详情 API，不要求登录、钱包、私钥、FC key 或 RPC。该命令被定义为匿名公共视图：即使本机已经执行 `finchip login`，CLI 也不会发送 Cookie、Authorization、Origin 或钱包签名，从而保证结果不依赖本地登录状态，并避免发送不必要的身份凭据。指定部署时，`--chain` 与 `--addr` 必须一起提供：

```bash
finchip skill show audit-pro-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --json
```

Site 有可能在找不到指定部署时回退到同 slug 的 canonical deployment。CLI 会逐字校验返回的 chain 与 contract，发现回退就返回 `SKILL_DEPLOYMENT_MISMATCH`，不会把另一个部署展示成用户指定的那个。详情中的 `deployment.price` 是 Site 展示值；购买前 `acquire` 始终重新从合约读取精确 `priceWei`。

`acquire` 不再使用配置中的默认链。省略部署时，它从公开详情取得 canonical chain 与 contract；指定时也必须同时传入 `--chain` 和 `--addr`。任何真实交易都要求显式 `--yes`：

- `--dry-run` 完成标准识别、链上价格/供应/持仓/余额读取、模拟和 gas 估算，但不签名、不广播。
- 不带 `--dry-run` 或 `--yes` 时仍完成只读 preflight，然后返回 `ACQUIRE_CONFIRM_REQUIRED`。
- `--yes` 才签名并广播；`--dry-run` 与 `--yes` 互斥。
- `--max-price` 和 `--max-gas-fee` 是可选的 Agent 预算护栏，分别限制链上价格与估算的最大 gas 费用。
- 已持有时返回 `ACQUIRE_ALREADY_HELD`；只有 `--force --yes` 才会再次购买。
- 广播后结果不确定时不会自动重发。`ACQUIRE_RESULT_UNKNOWN` 会带 tx hash，并要求先检查 receipt 或 `library`。

`skill show` 是任何人可用的公开详情；Creator 的完整可编辑状态仍由 `skill manage get` 提供。CLI 不再提供含义模糊的根级 `skill get`。

## Skill 评价与评分

```bash
finchip skill review list audit-pro-finchip
finchip skill review list audit-pro-finchip --limit 10 --json

finchip skill review submit audit-pro-finchip \
  --operational-independence 5 \
  --output-quality 4 \
  --model-compatibility 5 \
  --body "Works reliably in an agent workflow." \
  --dry-run

finchip skill review submit audit-pro-finchip \
  --operational-independence 5 \
  --output-quality 4 \
  --model-compatibility 5 \
  --body "Works reliably in an agent workflow." \
  --yes
```

`skill review list` 复用匿名公开详情读取已发布评价，不要求登录，也不发送 Cookie、钱包签名或其他身份材料。Site 最多返回最新 50 条；`--limit` 只限制 CLI 展示或 JSON 返回的条数，不会改变 Site 的排序。

提交评价采用“提交时当前持有”规则：

- 必须先 `finchip login`，且该账号需要绑定钱包。
- 登录钱包必须在所选部署上当前持有 license；ERC-1155 检查 token 1，ERC-721 检查钱包余额。
- Creator 不能评价自己的 Skill；同一账号对同一 Skill 只能发布一条评价。
- CLI 会先做链上持仓预检，但 Site 会在写入时再次独立校验；CLI 预检不是授权依据。
- `--dry-run` 只验证身份、部署和当前持仓；真正公开发布必须显式使用 `--yes`。

用户分别提交 Operational Independence、Output Quality、Model Compatibility 三项 1–5 分。总评分由 Site 取三项平均值生成，不单独接收一个可人为不一致的 overall rating。出售或转出 license 后，既有评价不会自动删除；“verified holder”只表示 Site 在提交当时验证通过。

删除命令为 `finchip skill review delete <slug> --review-id <id> --yes`。删除自己的评价只依据登录账号对该评价的所有权，不要求账号仍然持有 license，也不读取公开详情、链上余额或 RPC。`reviewId` 可从提交结果或 `review list --json` 取得；其他账号的评价会统一返回 `REVIEW_NOT_FOUND_OR_NOT_OWNED`。

## Skill 管理

```bash
finchip skill manage get my-skill-finchip --json
finchip skill manage apply my-skill-finchip --file ./manage.json --dry-run
finchip skill manage apply my-skill-finchip --file ./manage.json
finchip skill manage image set my-skill-finchip --file ./cover.png --dry-run
finchip skill manage image set my-skill-finchip --file ./cover.png --yes
finchip skill manage page upload my-skill-finchip \
  --kind instruction \
  --html ./instruction.html \
  --assets-dir ./assets \
  --dry-run
finchip skill manage page restore my-skill-finchip --kind instruction --yes
finchip skill manage attest my-skill-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --dry-run
finchip skill manage attest my-skill-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --yes

finchip skill price set my-skill-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --price 0.02 \
  --yes

finchip skill price sync my-skill-finchip \
  --chain bsc \
  --addr 0x1111111111111111111111111111111111111111 \
  --tx-hash 0xabababababababababababababababababababababababababababababababab
```

`skill manage get` 返回完整 Creator 状态和可直接编辑的 `editable` JSON。`manage apply` 接受最多 1 MiB 的声明式 JSON，`--file -` 可从 stdin 读取。省略字段保持不变；`supportedAgents` 与 `relatedSkillSlugs` 一旦出现就整体替换，空数组表示清空。可清除字段使用 `null` 或空字符串。

Manage API 只使用 `finchip login` 保存的 Cookie，不发送 viewer signature、`wallet_addr` 或 FC key。`imagePath` 只能通过后续的图片命令管理：它不会出现在 `editable`，也不会由 `manage apply` 发回 Site。关联 Skill 在 CLI 中使用 slug，发送 PATCH 前会精确解析为 Site 内部 ID；PATCH 后 CLI 会重新读取状态，检查 Agent 与关联 Skill 是否被 Site 原样保存。

图片支持 JPG、PNG、WebP、GIF，最大 4 MiB；CLI 会同时校验扩展名和 magic bytes。已有图片的替换需要 `--yes`，首次上传不需要。Site 当前没有单独删除图片的 Manage API，因此 CLI 不提供 image remove。

自定义 instruction、benchmark、showcase 页面由一个 HTML 文件和可选的平铺 assets 目录组成，总计最多 4 MiB。CLI 不递归目录、不跟随 symlink，禁止 JavaScript 资产、`<script>`、root-absolute URL 和嵌套 asset 路径；外部图片 host 最终仍由 Site 的账户 allowlist 判定。覆盖已有页面和 restore 会先清理服务器端资源，因此真实执行需要 `--yes`，网络结果不确定时 CLI 不会自动重试。

Creator Attestation 是独立、一次性且需要 gas 的链上操作，不会自动加入 publish。必须显式提供 `--chain` 和 `--addr`；CLI 会确认 Site 登录钱包、配置的 Agent 钱包和链上 immutable `genesisCreator` 三者一致，再用链上 slug 与 content hash 构造和 Site 相同的 EIP-712 payload。`--dry-run` 只比对本地 digest 与 `creatorAttestationDigest()`，不签名、不广播；真实写入还必须提供 `--yes`。旧合约会返回 `ATTESTATION_UNSUPPORTED`，已经验证的合约幂等返回 `CREATOR_ALREADY_VERIFIED`。

CLI 暂不创建 ERC-721 Chip，但已有 ERC-721 的查询、购买、持仓和二级市场操作继续支持。

## 市场、购买与持仓

```bash
finchip market list --chain bsc
finchip market search --chain base --category "Dev Environment"
finchip acquire --slug audit-pro-finchip --dry-run
finchip acquire --slug audit-pro-finchip --chain bsc --addr 0x1111111111111111111111111111111111111111 --yes
finchip library
finchip library --chain bsc
finchip library --chain optimism --json
```

Market 会通过 ERC-165 区分 ERC-1155 与 ERC-721。ERC-721 使用 `forkPrice / totalForked / maxForks`，不会按 ERC-1155 getter 读取。

`library` 的范围是 Site 当前活跃且可交易的 Chip 目录，不包含 inactive、orphan
或尚未进入 Site 的部署。目录请求是匿名公共读取，不携带 Cookie、Authorization、
Origin、钱包地址或签名。CLI 按链固定一个区块快照，每 100 个合约通过 Multicall
同时读取 ERC-1155 token 0/1 余额；只有两个 ERC-1155 调用都失败的地址才回退
ERC-721 `balanceOf(wallet)`，不会为几千个 ERC-1155 预先做 ERC-721 类型扫描。
实际持仓对应的历史目录 slug 如果无法转换成当前公共格式，CLI 会保留原始值并
返回 `CATALOG_SLUG_UNNORMALIZED` warning；未持有的目录条目不会产生该告警。
该展示字段不会阻断或降低链上持仓扫描的完整性。目录中的 creator 地址缺失或
被脱敏时不会为未持有的 Chip 产生噪音；实际持仓会使用链上 `creator()` 补全，
只有链上读取也失败时才通过 `METADATA_PARTIAL` 披露。

只对确认持有的少量 Chip 再从链上读取权威 `creator()` 与精确
`licensePrice/forkPrice`。若 Site 目录值滞后，链上值优先并返回
`CATALOG_STALE` warning。价格陈旧检测是 best-effort：Site 返回的
`price_wei` 可能已经以 JavaScript number 表示，超过安全整数范围后 CLI 不会拿
可能失真的值作精确比较，因此部分较大价格变化可能没有该 warning；输出的
`priceWei` 始终来自链上权威读取，不受此限制。部分 RPC 结果无法确认时，
`library --json` 仍以退出码 0 返回可信持仓，并使用
`code: "LIBRARY_PARTIAL"`、`complete: false` 和 `warnings` 披露缺口；Site
目录不可用或没有任何目标链得到可信扫描时才返回
`LIBRARY_SERVICE_UNAVAILABLE`。

二级市场：

```bash
finchip trade list --chain bsc
finchip trade buy --id 1 --chain bsc --yes
finchip trade sell --slug audit-pro-finchip --price 0.02 --chain bsc --yes
finchip trade sell --slug forkable-finchip --fork --token-id 7 --price 0.10 --chain bsc --yes
finchip trade cancel --id 1 --chain bsc --yes
```

`trade sell` 在任何 approval 或 `listToken` 广播前都会调用 Site 的公开
`/api/v2/trade/listings/preflight`。Site 统一计算
`availableQuantity = 当前持仓 - 当前卖家的活跃挂单数量`，校验 token standard、
Market approval，并模拟这次 `listToken`。库存有效但尚未授权时，CLI 才发送
approval；确认后会再次调用同一预检，再立即提交挂单。预检请求不携带登录
Cookie、Authorization、FC key 或钱包签名；Site/RPC 不可用或返回的 chain、
Market、Chip、seller 与本地交易不一致时，CLI 会停止，不退回旧的直连路径。
Site 返回的 creator 还必须与 CLI 随后读取的链上 `creator()` 一致；实际挂单
使用链上读取值，避免版税被路由到错误地址。

这是 Site UI 和 CLI 的正常流程安全约束，不是合约级限制：直接调用 Market
合约仍可绕过它，且预检与交易确认之间仍存在很短的链上状态变化窗口。

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
finchip pay https://finchip.ai/api/v1 --yes
```

`doctor` 检查 endpoint discovery 与链上协议状态；`protocol` 展示具体链的协议地址。`pay` 消费 x402 challenge 并签署 EIP-3009 USDC authorization。

## 配置

```bash
finchip config get
finchip config set chain base
finchip config unset rpc
```

钱包使用 `finchip wallet create/use/status/migrate` 管理。`finchip config set privateKey`
和直接设置 `privateKeyFile` 会被拒绝；后者必须经过 `wallet use` 的格式与地址验证。
`FINCHIP_PRIVATE_KEY` 与 `FINCHIP_PRIVATE_KEY_FILE` 已禁用。切换钱包统一使用
`finchip wallet use --file <path>`；若现有 Cookie session 属于另一个钱包，
CLI 会先尝试注销该 session，并始终清除本地旧 Cookie。相同钱包的 session 会保留。
`wallet status/use/create/migrate` 不会被陈旧变量阻断，也绝不会读取其值；它们会
返回 `ready: false` 和 `blockedBy` 变量名，提醒先清理环境再执行登录或签名命令。

历史配置中的 `pinataJwt` 不再被发布流程使用，但仍始终作为敏感字段遮罩，避免旧 secret 被 `config get` 输出。

## 主要命令

| Command | Purpose |
|---|---|
| `finchip login/status/logout` | Site 钱包账号 session |
| `finchip wallet create/use/status/migrate` | Agent 专用 EOA key file |
| `finchip init/register/verify` | fc_key 与 AgentRegistry 权限 |
| `finchip skill publish` | 唯一完整加密发布入口 |
| `finchip download` | 授权下载并解密；不安装、不执行 |
| `finchip skill list` | 浏览或按分类筛选 Site 的 Web3 Skill 目录 |
| `finchip skill search` | 搜索 Site 索引中的 Web3 Skill |
| `finchip skill show` | 匿名公开 Skill 详情 |
| `finchip skill review list/submit/delete` | 读取、提交或删除自己的评价 |
| `finchip skill manage/price` | Creator 管理 |
| `finchip market list/search` | 直接浏览链上 ERC-1155/721 registry |
| `finchip acquire` | 安全预检并显式确认购买 license 或 fork |
| `finchip library` | 按钱包查看持仓 |
| `finchip trade` | 二级市场 |
| `finchip chains/protocol/doctor` | 链与 A2A 检查 |
| `finchip pay` | x402 client |

## 开发验证

```bash
npm ci --ignore-scripts
npm test
npm run check:syntax
npm run check:package
npm audit --omit=dev --audit-level=high
git diff --check
```

仓库使用随 CLI 发布的 `npm-shrinkwrap.json` 固定开发、CI 和全局安装的依赖树。依赖升级应单独审查并重新通过完整门禁。

GitHub CI 覆盖 Node 22、24、26，以及 Linux、Windows、Windows Git Bash、Apple Silicon macOS 和 Intel macOS。Node 20 只运行不支持版本的启动守卫测试。

本地和 CI 测试不会默认执行真实 Site 发布、Oracle grant、下载或链上写入。

## Links

- Site: https://finchip.ai
- A2A entry: https://finchip.ai/a2aentry
- GitHub: https://github.com/Sleipnirs/finchip-cli
- npm: https://www.npmjs.com/package/finchip-cli

## License

MIT
