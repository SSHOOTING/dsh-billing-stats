# 账单格式与拟合方法

## 1. 导入

```powershell
npm run bill:import -- --bill .\账单.csv --out .\data\bill.normalized.jsonl
```

支持 CSV、JSON、JSONL。字段名可以使用英文或常见中文别名。

### 请求级账单

至少提供：

```text
request_id 或 request_key
provider
model
currency
amount
input_tokens
cache_read_tokens
cache_write_tokens
output_tokens
```

如果没有 `request_id`，可用 `session_id + turn + step` 与 usage ledger 对齐。

### 聚合账单

只有 `provider/model/currency/amount` 也能拟合，但只能得到总额倍率，不能把差额可靠拆到输入、缓存和输出单价上。

## 2. 拟合

```powershell
npm run bill:fit -- `
  --usage .\data\usage-ledger.jsonl `
  --bill .\data\bill.normalized.jsonl `
  --profile opencode-go `
  --out .\pricing\fitted\opencode-go.json
```

拟合分两步：

1. **总额校准**：`账户倍率 = 账单总额 / 公开价归因总额`。
2. **请求级分桶拟合**：请求级样本足够时，对未缓存输入、缓存读取、缓存写入、输出四列做非负最小二乘，把账户差额吸收到 token 单价。

输出文件带：

- 方法；
- usage / bill 样本数；
- 请求级匹配数；
- 公开价总额与账单总额；
- 聚合残差；
- 每个模型的行数、残差、MAPE。

## 3. 使用拟合结果

把输出文件作为新的 `pricingPath`，或在确认后替换 `pricing/profiles.json` 对应档案。插件不自动覆写主配置，避免一次实验污染全部历史。

## 4. 解释限制

- 聚合账单无法识别峰时、缓存、搜索和 token 桶各自的误差。
- 四列高度共线时，分桶系数可能不可辨识；此时应优先使用总额倍率。
- 负金额、退款和赠送额度应按供应商账单原样导入，并在报告中单独审计。
- 账单时区与请求时区不一致时，峰时分项可能错位。
