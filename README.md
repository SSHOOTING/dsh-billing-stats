# DSH 计费归因插件

`dsh-billing-attribution` 是 DSH 的只读计费观测插件，版本 `0.1.0`。它把 DSH 已产生的 usage、搜索账本和用户导入的供应商账单，转换成可解释的费用归因。

```mermaid
flowchart LR
  A[DSH 请求事件<br/>provider / model / usage] --> B[会话投影<br/>逐请求费用]
  C[搜索 shim 账本<br/>请求指纹与 token] --> B
  D[供应商账单<br/>CSV / JSON / JSONL] --> E[账单归一化]
  B --> E
  E --> F[价格档案拟合<br/>账户倍率或分桶单价]
  F --> G[/cost、dock 卡片<br/>HTML 报告]
```

插件边界：

- 不修改 `low / high / max` 思考档位；
- 不修改 `maxTokens`；
- 不阻断请求或工具调用；
- 不调用 LLM，也不需要网络。

## 核心能力

1. **逐请求归因**：未缓存输入、缓存读取、缓存写入、输出（含 reasoning）、搜索固定费和未知项分开显示。
2. **双口径金额**：同时显示公开价推算的 `list cost` 和按账户倍率折算的 `billed cost`。
3. **价格档案**：内置 DeepSeek 官方 API 与 OpenCode Go 两套独立配置；每个会话可用 `/cost profile` 切换。
4. **账单拟合**：导入 CSV/JSON/JSONL 账单，先按总额拟合账户倍率；请求级样本足够时再拟合分桶单价。
5. **可追溯**：usage ledger、搜索关联结果和拟合残差都保留在本地文件中。
6. **贴合原生 UI**：底部原生用量右侧显示“会话 ¥金额”胶囊；每轮完成行显示“用量 ¥金额 + 时间”；展开明细用金额替换 token 数，并增加搜索行。

## 快速开始

```powershell
npm test
npm run check
npm run bill:import -- --bill .\examples\bill.sample.csv --out .\data\bill.normalized.jsonl
npm run bill:fit -- --usage .\examples\usage.sample.jsonl --bill .\data\bill.normalized.jsonl --profile deepseek-official --out .\pricing\fitted\deepseek-official.json
npm run report -- --bill .\examples\bill.sample.csv --out .\reports\billing-explainer.html
```

默认数据文件：

```text
data/usage-ledger.jsonl        DSH usage 的追加式 JSONL ledger
data/search-state.json         每个会话的搜索账本游标与关联状态
pricing/profiles.json          当前价格档案
pricing/fitted/*.json          账单拟合输出，不自动覆盖主配置
```

## 安装与 DSH 加载方式

当前兼容范围是 DSH `0.2.0-rc.2`（`>=0.2.0-rc.2 <0.2.1`）。开发链接方式已在
Windows 的 web profile 中实测；发布包安装路径需在选定发布渠道后再做一次干净 profile
验收。DSH 支持 `dsh plugin --profile <profile> ...` 转发到 pnpm，实际 profile
目录由运行时的 `$DSH_HOME/profiles/<profile>` 决定，不应写死为某台机器的路径。

### A. 发布包安装

发布后可按实际渠道任选一种：

```powershell
# npm 包（仅在 npm 渠道确认并发布后可用）
dsh plugin --profile web add dsh-billing-attribution@0.1.0

# 本地或 GitHub Release 提供的 tarball
dsh plugin --profile web add E:\path\to\dsh-billing-attribution-0.1.0.tgz
```

安装后确认 profile 的 `package.json` 已在 `dsh.profile.bundles` 中加入
`dsh-billing-attribution`，再重启 DSH 的对应进程。发布包自带的
`cordis.patch.yml` 使用可移植默认值，并默认关闭搜索账本关联。

### B. 本地开发链接（当前已验证）

在 web profile 中把本仓库作为 link 依赖，并加入 profile bundle：

```powershell
dsh plugin --profile web add link:E:/programs/dsh-billing-attribution
```

等价的手工配置是：

```json
{
  "dependencies": {
    "dsh-billing-attribution": "link:E:/programs/dsh-billing-attribution"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-billing-attribution"
      ]
    }
  }
}
```

### C. 配置 profile patch

发布包默认从包内读取价格表，ledger 和搜索状态默认写入包目录。需要长期保留数据时，
应在 profile 的 `cordis.patch.yml` 中按插件 id 覆盖到可写的用户目录：

```yaml
- id: billing-attribution
  config:
    displayCurrency: CNY
    ledgerPath: '<可写数据目录>/usage-ledger.jsonl'
    searchStatePath: '<可写数据目录>/search-state.json'
    searchLedgerEnabled: true
    searchLedgerPath: '<搜索 shim 实际 JSONL 路径>'
    activeProfile: auto
    maxRecentRequests: 20
```

`searchLedgerPath` 必须指向实际搜索 shim 的 JSONL；不存在时插件只跳过搜索关联，不影响主模型计费。Host 代码改动后需要重启 DSH web 进程；只改客户端卡片后刷新页面即可。

### D. 在 DSH 中使用

```text
/cost                         查看本轮和会话累计
/cost explain                 查看最近一次请求的 token 与单价拆分
/cost profiles                查看价格档案和当前选择
/cost profile auto            恢复按 provider 自动选择
/cost profile opencode-go     切换到指定档案
```

档案切换只影响切换后的请求，历史请求不重算。输入框下方的金额胶囊与原生 token 用量、缓存命中率一样，统计整个会话所有轮次；处理中仍持续显示会话累计值，不会因当前轮暂时没有 usage 而消失。点击可查看缓存命中、未缓存输入、缓存读取、输出和搜索金额，不重复展示提供方/模型。每轮完成后，原生 token 用量按钮会替换为带人民币硬币图标的“用量 ¥金额”，时间仍显示在同一行。命令结果会作为持久化 flow 节点保留在会话中。

## 真实测试结果

2026-11-11 在 Windows、Node.js `v24.19.0`、DSH `0.2.0-rc.2` 环境实测：

| 项目 | 结果 |
|---|---|
| `npm test` | **21 / 21 通过**，0 失败 |
| `npm run check` | **17 个 `.js/.mjs` 文件全部通过** `node --check` |
| 账单导入样例 | 3 条记录，3 条请求级记录，归一化总额 `¥0.009320` |
| 账单拟合样例 | 3 条 usage、3 条账单、3 条请求级匹配；账户倍率 `1` |
| HTML 报告 | 生成成功；样例报告含 35 条 usage、3 条账单 |
| DSH `/cost` | 成功显示账单口径、公开价、请求数、最近请求和分项 |
| DSH `/cost explain` | 成功显示 token、单价、峰时倍率和金额 |
| DSH `/cost profiles` | 成功列出两套档案；模型数按实际模型定义计数 |
| DSH 档案切换 | `/cost profile opencode-go` 成功，后续视图切换为 OpenCode Go，历史金额不变 |
| 搜索账本关联 | 真实联网搜索已验证：ledger 状态 `settled`，归属第 2 轮第 1 步，搜索请求 1 次，固定费 `¥0.005` |
| 原生 UI 金额化 | 底部显示会话累计“会话费用 ¥0.4883”；每轮显示“用量 ¥金额 + 时间”；搜索汇总显示“¥0.0809 · 13 次” |

真实 DSH 测试过程中曾加载旧 Host 代码，卡片与 `/cost explain` 显示内部 token 字段名；重启 Host 后已确认修复。真实搜索验收使用的 ledger 为 `cf744663-8072-42a2-9e6a-3475ae5e98a2`，其中辅助模型 token 与 DeepSeek 搜索固定费分别归因，未使用 shim 自带的旧价格。

## 已知边界

- `list cost` 是公开价推算值，不保证等于账户实际扣款；`billed cost` 是账户倍率或拟合结果，不是发票。
- 当前固定汇率是 `1 USD = 7.2 CNY`；换汇率后必须重新计算，历史结果不会自动回写。
- 峰时窗口默认按北京时间工作日配置；法定节假日没有内置日历，不能擅自推断。
- 缓存是否命中只认供应商返回的 cache read token，不从重复 query 或时间间隔推断。
- 搜索请求按请求体指纹和 FIFO 做 best-effort 关联；精确 request id 可用时优先使用 request id。
- 聚合账单只能可靠拟合总额倍率；没有请求级账单时，不能把差额可靠拆成四个 token 桶的单价。
- 价格档案里的搜索固定费和部分模型价格仍标记为待验证，需用真实账单复核。
- 负金额、退款和赠送额度的展示与冲销规则仍属于后续版本范围。

## 仍需用户提供的数据

1. DeepSeek 官方与 OpenCode Go 的**真实账单导出**，最好包含请求级 `request_id` 或 `session_id + turn + step`。
2. 至少一份包含搜索请求的真实账单，用于复核 `¥0.005 / 搜索请求` 和搜索 token 是否被重复计费。
3. 实际账户的 allowance、折扣或套餐倍率证据，用于替换当前经验值 `×0.6`。
4. 若需要峰时精确归因，需要供应商正式说明的峰时窗口、节假日规则和是否作用于搜索费。

## 详细文档

- [安装与回滚说明](install/README.md)
- [计费模型与实验边界](docs/BILLING-MODEL.md)
- [账单格式与拟合方法](docs/BILL-FITTING.md)
- [可视化计费说明](docs/billing-explainer.html)
