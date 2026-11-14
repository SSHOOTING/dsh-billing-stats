# Changelog

本项目从 `dsh-billing-stats v0.1.0` 开始记录用户可见变更、验证结果和已知边界。

## [Unreleased]

### 修复

- 中断、断流或供应商遗漏 usage 时，不再把缺失费用显示为 `¥0.000000`。
- 增加费用证据优先级：请求级账单明细 > 官方 usage > 可见文本兜底估算 > 未知。
- 费用来源作为独立标签展示；不再拼接“¥已知金额 + 未知”这种不可比较的金额字符串。
- 请求级账单明细覆盖同一请求的其它证据时不会重复计数。

### 验证

- `npm test`：24 / 24 通过。
- `npm run check`：18 个 JS/MJS 文件通过语法检查。
- 用户中止的真实会话：官方 usage 缺失，按可见文本与工具定义估算为 `¥0.0118`，
  来源标记为“文本估算”。

## [0.1.0] - 2026-11-11

### 已实现能力

- 只读计费统计：从 DSH 请求事件读取 provider、model 和 usage，不修改思考档位、
  `maxTokens`、请求内容或工具调用。
- 逐请求与逐轮金额：拆分未缓存输入、缓存读取、缓存写入、输出（含 reasoning）、
  搜索固定费和未知项。
- 双口径费用：同时提供公开价推算的 `list cost` 与按账户倍率/拟合结果折算的
  `billed cost`。
- 价格档案：内置 DeepSeek 官方 API 与 OpenCode Go 配置，支持 `/cost profile` 切换；
  历史请求不按新档案重算。
- 账单导入与拟合：支持 CSV、JSON、JSONL；先拟合账户总额倍率，请求级样本充足时再拟合
  分桶单价。
- 搜索账本关联：按请求体指纹与 FIFO 关联搜索请求，并在账本中保留结算状态和关联结果。
- DSH 原生界面集成：底部会话金额胶囊、每轮“用量 ¥金额 + 时间”、展开明细中的金额与
  搜索行。
- 命令与报告：提供 `/cost`、`/cost explain`、`/cost profiles`、`/cost profile`，
  以及可离线生成的 HTML 费用说明报告。

### 验证结果

以下为 2026-11-11 的真实记录：

| 验证项 | 结果 |
|---|---|
| `npm test` | 21 / 21 通过，0 失败 |
| `npm run check` | 17 个 `.js/.mjs` 文件通过 `node --check` |
| 账单导入样例 | 3 条记录、3 条请求级记录，归一化总额 `¥0.009320` |
| 账单拟合样例 | 3 条 usage、3 条账单、3 条请求级匹配；账户倍率 `1` |
| HTML 报告 | 生成成功；样例含 35 条 usage、3 条账单 |
| DSH `0.2.0-rc.2` web profile | `/cost`、`/cost explain`、`/cost profiles`、档案切换和原生金额 UI 已实测 |
| 真实搜索关联 | ledger 状态 `settled`，搜索请求 1 次，固定费 `¥0.005` |

### 已知边界

- `list cost` 是公开价推算值，不等同于实际扣款；`billed cost` 是归因结果，不是发票。
- 固定汇率 `1 USD = 7.2 CNY`；汇率变化后，历史结果不会自动回写。
- 峰时窗口按北京时间工作日配置，不内置法定节假日日历。
- 缓存命中只认供应商返回的 cache read token，不从重复 query 或时间间隔推断。
- 搜索关联是 best-effort；缺少精确 request id 时存在错配可能。
- 聚合账单只能可靠拟合总额倍率，不能可靠拆分缺少请求级证据的四个 token 桶。
- 价格档案中的搜索固定费和部分模型价格仍待真实账单复核。
- 负金额、退款、赠送额度和跨账单冲销不在本版本范围内。
- 发布包的 ledger/search state 默认位于包目录；长期使用应覆盖到用户可写且可备份的位置。

### 发布说明

- 包名统一为 `dsh-billing-stats`，版本 `0.1.0` 已于 2026-11-12 发布到 npm：
  `https://www.npmjs.com/package/dsh-billing-stats`。
- 许可证为 MIT；GitHub 仓库为
  `https://github.com/SSHOOTING/dsh-billing-stats`。
- GitHub Release `v0.1.0` 已发布，并附 npm 同版本 tarball 与 SHA-256 校验文件：
  `https://github.com/SSHOOTING/dsh-billing-stats/releases/tag/v0.1.0`。
- DSH 市场目录提交仍需等待仓库创建满 1 天后进行。
