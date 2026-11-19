# DSH Billing Stats v1.1.1

`dsh-billing-stats` 的首个稳定版。产品定位收敛为**极简、只读、原生集成**：不新增独立
dashboard，只在 DSH 原本就会看的两个位置显示费用。

## 亮点

- 每轮回答末尾显示本轮金额、费用来源与时间。
- 会话输入框下方显示整个 session 的累计金额，点击可展开费用拆分。
- 不调用 LLM，不修改请求、思考档位或 `maxTokens`，不阻断工具调用。
- 费用证据按“请求级账单明细 > 官方 usage > 可见文本估算 > 未知”选择，并始终标注来源。
- 同时提供公开价参考与账单口径，适合订阅账号估算等价 API 价值。
- 本地 JSONL ledger、搜索关联状态和拟合结果可追溯。

## README 更新

- 首屏明确“极简”定位和两个原生展示位置。
- 新增两张真实 DSH 会话截图：
  - `docs/images/readme-turn-cost.png`
  - `docs/images/readme-session-cost.png`
- 安装示例、GitHub Release tarball 链接和版本号统一更新到 `1.1.1`。
- 两张 README 截图改为准确近景：本轮用量金额，以及 DSH 底部会话信息栏。

## 兼容性

- DSH：`>=0.2.0-rc.2 <0.2.1`，当前验证版本为 `0.2.0-rc.2`。
- Node.js：`^22.19.0 || >=24.0.0`。
- 界面：web profile。

## 安装

```powershell
dsh plugin --profile web add dsh-billing-stats@1.1.1

# 或使用 GitHub Release 提供的同版本 tarball
dsh plugin --profile web add https://github.com/SSHOOTING/dsh-billing-stats/releases/download/v1.1.1/dsh-billing-stats-1.1.1.tgz
```

安装后重启 DSH web 进程，然后在会话中执行：

```text
/cost
/cost explain
/cost profiles
/cost profile auto
```

## 验证摘要

- `npm test`：24 / 24 通过。
- `npm run check`：18 个 JS/MJS 文件通过语法检查。
- 真实 DSH web 会话已验证每轮费用、会话累计费用和展开明细。
- 中断或缺 usage 的请求会标注费用来源，不把未知金额伪装成 `¥0`。

## 已知边界

- 当前只内置 DeepSeek 系列模型价格；其他模型需要自备价格档案。
- 公开价是等价推算，账单口径是归因结果，二者都不是供应商发票。
- 固定汇率 `1 USD = 7.2 CNY`，历史结果不会随汇率自动重算。
- 搜索关联在缺少精确 request id 时是 best-effort。
- 负金额、退款、赠送额度和跨账单冲销不在当前版本范围内。
