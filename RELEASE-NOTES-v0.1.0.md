# DSH Billing Stats v0.1.0

`dsh-billing-stats` 是 DSH 的只读计费统计插件：把已经产生的 usage、搜索账本和
用户导入的供应商账单，转换为可解释的费用统计。它不调用 LLM、不联网请求模型、不修改
请求、思考档位或 `maxTokens`，也不阻断工具调用。

> npm 包已发布：`https://www.npmjs.com/package/dsh-billing-stats`。MIT 许可证、
> GitHub 仓库和 DSH web profile 兼容范围均已确认。

## 亮点

- 逐请求、逐轮和会话累计金额；公开价与账单口径并列显示。
- 未缓存输入、缓存读取、缓存写入、输出（含 reasoning）和搜索固定费分项。
- DeepSeek 官方 API 与 OpenCode Go 两套价格档案，可在会话中切换。
- CSV / JSON / JSONL 账单导入，支持总额倍率与请求级分桶拟合。
- DSH 原生会话底部金额胶囊、每轮金额、展开明细和搜索行。
- 本地 JSONL ledger、搜索关联状态和拟合残差，结果可追溯。

## 兼容性

- DSH：`>=0.2.0-rc.2 <0.2.1`，当前验证版本为 `0.2.0-rc.2`。
- Node.js：`^22.19.0 || >=24.0.0`。
- 界面：web profile。
- 安装：DSH profile 通过 `dsh plugin --profile <profile> add ...` 转发到 pnpm；插件无
  构建步骤。

## 安装

```powershell
dsh plugin --profile web add dsh-billing-stats@0.1.0

# 或使用 GitHub Release 提供的同版本 tarball
dsh plugin --profile web add https://github.com/SSHOOTING/dsh-billing-stats/releases/download/v0.1.0/dsh-billing-stats-0.1.0.tgz
```

安装后重启 DSH，然后在会话中执行：

```text
/cost
/cost explain
/cost profiles
/cost profile auto
```

## 验证摘要

2026-11-11 在 Windows、Node.js `v24.19.0`、DSH `0.2.0-rc.2` 的 web profile 中记录：

- `npm test`：21 / 21 通过。
- `npm run check`：17 个 JS/MJS 文件通过语法检查。
- `/cost`、`/cost explain`、`/cost profiles`、档案切换和原生金额 UI 已实测。
- 真实搜索账本关联达到 `settled`，搜索固定费按 `¥0.005` 归因。

本次发布准备还执行了本地 `npm pack --dry-run`、tarball 内容检查和打包后导入冒烟测试；
最终结果以 `RELEASE-CHECKLIST.md` 更新后的记录为准。

## 已知边界

- 归因结果不是供应商发票；公开价与账单口径可能不同。
- 固定汇率 `1 USD = 7.2 CNY`，历史结果不会随汇率自动重算。
- 节假日峰时规则、请求级账单缺口、退款/赠送额度和负金额规则仍是后续工作。
- 搜索关联在缺少精确 request id 时是 best-effort。
- 发布包若使用默认包内 ledger 路径，升级时可能丢失数据；长期使用应覆盖到用户目录。

## 发布状态

- [x] 许可证：MIT，`LICENSE` 已加入；
- [x] GitHub 仓库：`SSHOOTING/dsh-billing-stats`，公开并已推送；
- [x] npm 渠道与包名：`dsh-billing-stats@0.1.0`；
- [x] npm 2FA：已启用 Windows Hello / security key；
- [x] npm publish：`https://www.npmjs.com/package/dsh-billing-stats`；
- [x] GitHub Release：
  `https://github.com/SSHOOTING/dsh-billing-stats/releases/tag/v0.1.0`；
- [ ] DSH 市场目录 listing 的 PR 与审核。
