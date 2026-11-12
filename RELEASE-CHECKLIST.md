# v0.1.0 发布清单

状态说明：`[x]` 表示本轮已实际验证，或明确来自仓库中记录的既有实测；`[ ]` 表示尚未
完成或需要用户确认。计划和推测不会被标成已通过。

## 1. 版本与渠道

| 项目 | 当前值 | 状态 |
|---|---|---|
| 包名 | `dsh-billing-stats` | 用户已选定；npm registry 查询为 404（当前可用） |
| 版本 | `0.1.0` | 已写入 `package.json` |
| Git 基线 | `99ac038ba6a27a5c2c935a15f8123d9c8c53fdef` | 已确认 |
| DSH 目标 | `>=0.2.0-rc.2 <0.2.1` | 已写入 `engines.dsh`；本机实测 `0.2.0-rc.2` |
| Node 目标 | `^22.19.0 || >=24.0.0` | 已写入 `engines.node` |
| 许可证 | MIT | 已写入 `LICENSE` 和 `package.json` |
| 远端仓库 | `SSHOOTING/dsh-billing-stats` | 已创建为公开仓库，main 已推送 |
| npm 可发布性 | `dsh-billing-stats@0.1.0` 已发布为 `latest` | 已完成 |
| DSH 市场 | 用户选择提交 | 需要 GitHub 登录、仓库公开和目录 PR |

### 渠道建议（供选择，不代表已选定）

| 渠道 | 适合用途 | 当前缺口 | 建议 |
|---|---|---|---|
| npm 包 | DSH 的常规安装、升级、版本发现；也是市场更新最顺的路径 | 需要 npm 登录、2FA 和包名复核 | **用户已选择**；发布 `dsh-billing-stats@0.1.0` |
| GitHub Release | 公开源码、变更记录、附 tarball 和校验和；不依赖 npm 账号 | 需要 GitHub 登录并创建 `SSHOOTING/dsh-billing-stats` | 与 npm 同版本发布，附 tarball |
| DSH 插件市场/目录 | 让用户可搜索、安装和升级 | 需要公开可安装来源；还要向 awesome-dsh-plugin 提交目录 PR 并等待审核 | 用户已选择；来源就绪后提交 |

## 2. 依赖与构建

- [x] Node.js `v24.19.0`
- [x] npm `11.17.0`
- [x] pnpm `11.25.0`
- [x] Git `2.56.0.windows.4`
- [x] DSH CLI `0.2.0-rc.2` 存在，路径为
  `E:\program\DeepSeek\app\node_modules\.bin\dsh.cmd`
- [x] 无运行时 `dependencies`；DSH、React 与服务包由宿主提供
- [x] `engines.node`、`engines.dsh`、`peerDependencies` 与本机 DSH 版本相符
- [x] 无编译/打包脚本；发布包直接包含 ESM 源码与客户端 bundle
- [x] `npm pack --dry-run` 可用
- [x] 2026-11-11 查询 npm registry：`dsh-billing-stats` 返回 404，当前未被占用
- [ ] 发布前确认所有 peer dependency 版本范围仍与目标 DSH 一致

### 已修正的打包问题

- [x] `files` 不再包含整个 `pricing/`，避免把本地生成的
  `pricing/fitted/deepseek-official.json` 打进发布包。
- [x] bundle patch 不再写死本机 `E:/programs/...` 路径。
- [x] bundle patch 默认关闭搜索账本，避免向其他机器引用本机搜索 shim。
- [ ] 确认发布包的默认包内 ledger/search state 路径可写；长期使用应改为用户目录。

## 3. 测试与包内容

- [x] `npm test`：21 / 21 通过，0 失败。
- [x] `npm run check`：17 个文件全部通过。
- [x] 改名后的 `npm test` 与 `npm run check` 通过。
- [x] 改名后 `npm pack --dry-run`：20 个条目，压缩大小 `48,740` bytes。
- [x] 改名后候选 tarball：`.release-artifacts/dsh-billing-stats-0.1.0.tgz`，
  unpacked 大小 `176,780` bytes。
- [x] 解压候选 tarball 并执行 Node ESM 导入冒烟：导出
  `name=billing-stats`、`inject=["commands","sessionProjections"]`、
  `typeof apply=function`。
- [x] 候选 tarball SHA-256：
  `F649E181E4FC60EC30500042DC03406DE7E3C7D349DC6F5EF7F6102D00DA17F9`。
- [x] 已确认改名后的 tarball 不含 `data/*`、`reports/`、`experiments/`、
  `pricing/fitted/`。
- [x] npm 账户已启用 auth-and-writes 2FA（Windows Hello / security key）。
- [x] `npm publish --access public` 已于 2026-11-12 成功：
  `dsh-billing-stats@0.1.0`，dist-tag 为 `latest`。
- [x] npm registry 已确认 tarball：
  `https://registry.npmjs.org/dsh-billing-stats/-/dsh-billing-stats-0.1.0.tgz`。
- [x] 已确认 README、CHANGELOG、LICENSE、发布说明、安装文档和两份计费 docs
  均在 tarball 中。
- [x] npm 在首次 staged publishing 流程中自动创建了 `0.0.0-stage` 占位版本；
  `latest` 正确指向 `0.1.0`。

## 4. 安装与 DSH 重启验证

- [x] 本仓库当前通过 junction 链接进入 web profile；这个状态属于开发链接，不是发布包安装。
- [x] README 已记录 DSH `0.2.0-rc.2` web profile 的真实功能验收结果。
- [x] 已定位 DSH CLI 的启动方式：`dsh plugin --profile web add ...` 转发给 profile 的 pnpm。
- [x] 已确认给 DSH 注入正确 `DSH_HOME` 的启动脚本存在；命令行默认目录与阅读文档必须区分。
- [x] 在隔离临时 `DSH_HOME` 中验证 `dsh plugin --profile web --help` 路径：DSH 成功
  初始化临时 web profile，并将命令转发给 pnpm `11.25.0`，退出码为 0；未安装插件。
- [x] GitHub 公开仓库已创建并配置 remote：`origin` 指向
  `https://github.com/SSHOOTING/dsh-billing-stats.git`。
- [x] GitHub topic 已设置：`dsh-plugin`、`deepseek-harness`、`billing`。
- [x] 已在隔离临时 `DSH_HOME` 中从 npm 安装 `dsh-billing-stats@0.1.0`：
  pnpm 成功安装，profile 自动加入依赖和 `dsh.profile.bundles`。
- [x] 临时 profile 的 `dsh --profile web --dump-config` 成功合成
  `billing-attribution`，并加载可移植 bundle patch：
  `displayCurrency=CNY`、`searchLedgerEnabled=false`。
- [ ] 重启 DSH web 进程，确认日志出现 `[billing-stats] active`。
- [ ] 执行 `/cost`、`/cost explain`、`/cost profiles`。
- [ ] 发一轮受控请求，确认底部会话金额、每轮金额和展开明细。
- [ ] 如启用搜索，确认真实账本记录归因到正确轮次。
- [ ] 退出临时 profile，确认不影响当前已验收的 web profile。

## 5. 回滚

- [ ] 安装前备份 profile 的 `package.json`、`pnpm-lock.yaml` 和 `cordis.patch.yml`。
- [ ] 回滚步骤已写入 `install/README.md`：
  - 移除 `dsh-billing-stats` 依赖与 bundle 项；
  - 恢复 profile patch；
  - 同步依赖；
  - 重启 DSH；
  - 确认 `/cost` 不再注册且其他插件正常加载。
- [ ] 回滚不删除用户 ledger；账本由用户决定保留或归档。

## 6. 发布产物

- [x] 最终 `package.json` 元数据已补：MIT、repository、homepage、bugs。
- [x] npm 包名 `dsh-billing-stats` 当前可用；`private` 已移除，已设置 public
  `publishConfig`。
- [x] 已重新生成候选 tarball `dsh-billing-stats-0.1.0.tgz` 并计算哈希。
- [x] SHA-256 校验和文件：`.release-artifacts/SHA256SUMS`。
- [x] GitHub Release 说明采用 `RELEASE-NOTES-v0.1.0.md` 的最终版本。
- [x] 发布说明明确标注“结果不是供应商发票”。

## 7. 发布后检查

- [x] npm registry 已返回 `latest = 0.1.0`、MIT 和 20 个文件。
- [x] GitHub Release `v0.1.0` 已创建，包含 npm 同版本 tarball 与 SHA-256 校验文件：
  `https://github.com/SSHOOTING/dsh-billing-stats/releases/tag/v0.1.0`。
- [x] 发布附件 digest 与本地/registry tarball 一致：
  `f649e181e4fc60ec30500042dc03406de7e3c7d349dc6f5ef7f6102d00da17f9`。
- [ ] 从公开来源安装一次，不依赖本机开发链接。
- [ ] DSH 安装后重启成功，客户端 UI 与 `/cost` 命令可用。
- [ ] 升级路径可用：安装下一版本时不会覆盖用户 ledger 数据。
- [ ] 记录发布 URL、发布时间、tarball 哈希和验证人。
- [ ] 如提交 DSH 市场：确认 catalog 条目、安装源、版本和兼容范围一致。
- [x] 已准备 awesome-dsh-plugin 目录条目：
  `market/awesome-dsh-plugin.yml`。
- [ ] GitHub 仓库创建于 `2026-11-11T13:49:11Z`，需等到
  `2026-11-12T13:49:11Z` 后才能提交目录 PR。

## 8. 外部动作闸门

以下动作尚未执行，必须等待外部条件满足：

- 提交 DSH 市场/目录
- 安装新软件到系统
