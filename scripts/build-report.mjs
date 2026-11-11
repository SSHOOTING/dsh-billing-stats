#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { importBillFile } from '../src/bill-import.js'
import { foldUsageRecords, readUsageLedger } from '../src/fitting.js'
import {
  formatMoney,
  loadPricingCatalog,
  priceSearchLedgerRecord,
  priceUsage,
} from '../src/pricing.js'

const args = parseArgs(process.argv.slice(2))
const usagePath = resolve(String(args.usage ?? 'data/usage-ledger.jsonl'))
const outPath = resolve(String(args.out ?? 'docs/billing-explainer.html'))
const catalogPath = resolve(String(args.catalog ?? 'pricing/profiles.json'))
const searchPath = args['search-ledger'] === undefined
  ? null
  : resolve(String(args['search-ledger']))
const billPath = args.bill === undefined ? null : resolve(String(args.bill))
const catalog = loadPricingCatalog(catalogPath)
const usage = existsSync(usagePath) ? foldUsageRecords(readUsageLedger(usagePath)) : []
const searches = searchPath !== null && existsSync(searchPath)
  ? readJsonLines(searchPath).map(record => ({
      record,
      priced: priceSearchLedgerRecord(catalog, record),
    }))
  : []
const billRecords = billPath !== null && existsSync(billPath) ? importBillFile(billPath) : []

const pricedUsage = usage.map(record => ({
  record,
  priced: priceUsage(catalog, {
    provider: record.provider,
    model: record.model,
    usage: record.buckets,
    profile: record.profileId ?? 'auto',
    at: record.observedAt,
    requestKind: record.requestKind ?? 'model',
  }),
}))
const usageListMicros = pricedUsage.reduce((sum, item) => sum + item.priced.listMicros, 0)
const usageBilledMicros = pricedUsage.reduce((sum, item) => sum + item.priced.billedMicros, 0)
const searchListMicros = searches.reduce((sum, item) => sum + item.priced.listMicros, 0)
const searchBilledMicros = searches.reduce((sum, item) => sum + item.priced.billedMicros, 0)
const totalListMicros = usageListMicros + searchListMicros
const totalBilledMicros = usageBilledMicros + searchBilledMicros
const billMicros = billRecords.reduce((sum, record) => sum + record.amountMicros, 0)

const components = {
  uncachedInput: { label: '未缓存输入', listMicros: 0, billedMicros: 0 },
  cacheRead: { label: '缓存读取', listMicros: 0, billedMicros: 0 },
  cacheWrite: { label: '缓存写入', listMicros: 0, billedMicros: 0 },
  output: { label: '输出（含 reasoning）', listMicros: 0, billedMicros: 0 },
  searchFee: { label: '搜索固定费', listMicros: 0, billedMicros: 0 },
  searchToken: { label: '搜索模型 token', listMicros: 0, billedMicros: 0 },
}
for (const { priced } of pricedUsage) {
  for (const component of priced.components ?? []) {
    const key = component.kind === 'fixed-search-fee'
      ? 'searchFee'
      : component.category === 'search-token'
        ? 'searchToken'
        : reportComponentKey(component.bucket)
    if (components[key] === undefined) continue
    components[key].listMicros += component.listMicros ?? 0
    components[key].billedMicros += component.billedMicros ?? 0
  }
}
for (const item of searches) {
  for (const component of item.priced.components) {
    const key = component.category === 'search-fee'
      ? 'searchFee'
      : component.category === 'search-token'
        ? 'searchToken'
        : reportComponentKey(component.bucket) ?? 'searchToken'
    if (components[key] === undefined) continue
    components[key].listMicros += component.listMicros ?? 0
    components[key].billedMicros += component.billedMicros ?? 0
  }
}

const html = renderHtml({
  catalog,
  usage: pricedUsage.map(item => ({
    ...item.record,
    ...item.priced,
    observedAt: item.record.observedAt,
  })),
  searches,
  billRecords,
  components,
  totalListMicros,
  totalBilledMicros,
  billMicros,
  usagePath,
  searchPath,
  billPath,
})
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, html, 'utf8')
console.log(JSON.stringify({
  ok: true,
  out: outPath,
  usageRecords: usage.length,
  searchRecords: searches.length,
  billRecords: billRecords.length,
  listMicros: totalListMicros,
  billedMicros: totalBilledMicros,
  billMicros,
}, null, 2))

function renderHtml(context) {
  const total = Math.max(1, context.totalBilledMicros)
  const rows = Object.entries(context.components)
    .filter(([, value]) => value.billedMicros > 0 || value.listMicros > 0)
    .sort((left, right) => right[1].billedMicros - left[1].billedMicros)
    .map(([key, value]) => {
      const percent = Math.max(1, Math.round(value.billedMicros / total * 100))
      return `<div class="bar-row">
        <div class="bar-label">${escapeHtml(value.label)}</div>
        <div class="bar-track"><div class="bar-fill ${escapeHtml(key)}" style="width:${percent}%"></div></div>
        <div class="bar-value">${formatMoney(value.billedMicros, context.catalog.displayCurrency)} · ${percent}%</div>
      </div>`
    }).join('')

  const requestRows = [
    ...context.usage.map(record => ({
      kind: '主模型',
      at: record.observedAt,
      provider: record.provider,
      model: record.model,
      status: record.status,
      listMicros: record.listMicros,
      billedMicros: record.billedMicros,
      tokens: `${record.buckets.uncachedInputTokens} / ${record.buckets.cacheReadTokens} / ${record.buckets.cacheWriteTokens} / ${record.buckets.outputTokens}`,
      note: record.unknownComponents?.join('; ') || '',
    })),
    ...context.searches.map(({ record, priced }) => ({
      kind: '搜索',
      at: record.startedAt,
      provider: record.mode ?? 'search',
      model: record.attempts?.map(attempt => attempt.model).filter(Boolean).join(' + ') || 'unknown',
      status: priced.status,
      listMicros: priced.listMicros,
      billedMicros: priced.billedMicros,
      tokens: `${priced.components.filter(item => item.kind === 'token').reduce((sum, item) => sum + item.tokens, 0)} tokens`,
      note: priced.unknownComponents.join('; '),
    })),
  ].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
    .slice(0, 120)
    .map(row => `<tr>
      <td>${escapeHtml(row.kind)}</td>
      <td>${escapeHtml(row.at ?? '')}</td>
      <td>${escapeHtml(row.provider ?? '')}/${escapeHtml(row.model ?? '')}</td>
      <td>${escapeHtml(row.status ?? '')}</td>
      <td>${escapeHtml(row.tokens)}</td>
      <td>${formatMoney(row.listMicros, context.catalog.displayCurrency)}</td>
      <td><strong>${formatMoney(row.billedMicros, context.catalog.displayCurrency)}</strong></td>
      <td>${escapeHtml(row.note)}</td>
    </tr>`).join('')

  const billDelta = context.billRecords.length === 0
    ? '未导入账单'
    : `${formatMoney(context.billMicros, context.catalog.displayCurrency)}；与归因差 ${formatMoney(context.billMicros - context.totalBilledMicros, context.catalog.displayCurrency)}`
  const profileCards = [...context.catalog.profiles.values()].map(profile => `<article class="card">
    <div class="card-kicker">${profile.billingBasis === 'subscription-allowance' ? '订阅/额度口径' : '按量计费'}</div>
    <h3>${escapeHtml(profile.label)}</h3>
    <p>账户倍率 ×${profile.accountMultiplier}</p>
    <p class="muted">${escapeHtml(profile.accountMultiplierSource ?? profile.source ?? '未提供倍率来源')}</p>
    <p>${profile.modelCount ?? profile.models.size} 个模型价格；${profile.verified ? '已验证' : '待验证'}</p>
  </article>`).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 每次请求到底花了什么钱</title>
<style>
:root{color-scheme:light dark;--bg:#f6f4ef;--ink:#1d2524;--muted:#69736f;--card:#fffdf8;--line:#d9d4c8;--accent:#176b57;--accent2:#d06c36;--blue:#3b6f99;--yellow:#b78b2f;--red:#b34b4b}
@media(prefers-color-scheme:dark){:root{--bg:#171b1a;--ink:#e9eee9;--muted:#a3ada8;--card:#202625;--line:#35403d;--accent:#6cc6a8;--accent2:#ef9d68;--blue:#7aa9ce;--yellow:#d8b45d;--red:#e48383}}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(140deg,var(--bg),color-mix(in srgb,var(--bg) 82%,var(--accent) 18%));color:var(--ink);font:15px/1.65 "Segoe UI","Noto Sans SC",system-ui,sans-serif}
main{max-width:1160px;margin:0 auto;padding:52px 24px 80px}h1,h2,h3{line-height:1.18}h1{font-size:clamp(34px,6vw,68px);letter-spacing:-.04em;margin:0 0 16px;max-width:900px}h2{margin:56px 0 18px;font-size:26px}h3{margin:8px 0}.lede{font-size:19px;color:var(--muted);max-width:820px}.hero{padding-bottom:20px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.05)}
.metric{font-size:29px;font-weight:750;letter-spacing:-.03em}.card-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);font-weight:700}.muted{color:var(--muted)}
.bar-row{display:grid;grid-template-columns:180px 1fr 170px;gap:14px;align-items:center;margin:12px 0}.bar-track{height:14px;background:color-mix(in srgb,var(--line) 72%,transparent);border-radius:99px;overflow:hidden}.bar-fill{height:100%;border-radius:99px;background:var(--accent)}.bar-fill.cacheRead{background:var(--accent2)}.bar-fill.output{background:var(--blue)}.bar-fill.searchFee{background:var(--yellow)}.bar-fill.searchToken{background:var(--red)}.bar-value{text-align:right;font-variant-numeric:tabular-nums}.bar-label{font-weight:650}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:block;overflow-x:auto}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:color-mix(in srgb,var(--card) 75%,var(--accent) 5%)}
.flow{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;align-items:stretch}.flow-step{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-height:112px}.flow-step:not(:last-child):after{content:"→";position:absolute;right:-15px;top:43%;z-index:2;color:var(--accent);font-size:20px;font-weight:800}.flow-step b{display:block;margin-bottom:5px}.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-size:12px;font-weight:700}.callout{border-left:4px solid var(--accent2);padding:14px 18px;background:color-mix(in srgb,var(--card) 86%,var(--accent2) 14%);border-radius:0 14px 14px 0}.formula{font:14px/1.7 "Cascadia Code","SFMono-Regular",monospace;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;overflow:auto}.small{font-size:13px}.footer{margin-top:56px;color:var(--muted);font-size:13px}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.flow{grid-template-columns:1fr}.flow-step:not(:last-child):after{content:"↓";right:50%;top:auto;bottom:-17px}.bar-row{grid-template-columns:120px 1fr}.bar-value{grid-column:2;text-align:left}}@media(max-width:560px){main{padding:28px 14px}.grid{grid-template-columns:1fr}.bar-row{grid-template-columns:1fr}.bar-value{grid-column:1}}
</style>
</head>
<body><main>
<header class="hero">
<span class="tag">本地脚本生成 · 无 LLM 参与</span>
<h1>每次请求，钱到底花在了哪里？</h1>
<p class="lede">这不是一张“猜出来的余额”，而是一份可追溯的账单归因：公开价、账户倍率、缓存、峰谷、输出和搜索各算各的。缺少数据时显示“未知”，不拿 0 填充。</p>
</header>

<section class="grid">
<article class="card"><div class="card-kicker">账单口径</div><div class="metric">${formatMoney(context.totalBilledMicros, context.catalog.displayCurrency)}</div><p>按当前价格档案归因</p></article>
<article class="card"><div class="card-kicker">公开价口径</div><div class="metric">${formatMoney(context.totalListMicros, context.catalog.displayCurrency)}</div><p>未乘账户倍率</p></article>
<article class="card"><div class="card-kicker">请求样本</div><div class="metric">${context.usage.length + context.searches.length}</div><p>主模型 ${context.usage.length} + 搜索 ${context.searches.length}</p></article>
<article class="card"><div class="card-kicker">导入账单</div><div class="metric">${escapeHtml(billDelta)}</div><p>用于拟合与残差检查</p></article>
</section>

<h2>一次请求的费用骨架</h2>
<div class="formula">费用 = 未缓存输入 × 输入单价
     + 缓存读取 × 缓存读取单价
     + 缓存写入 × 缓存写入单价
     + 输出（含 reasoning）× 输出单价
     + 搜索固定费 × 搜索次数
     + 其他可证明的固定费用

峰时请求：token 分项再乘峰时倍率
账户/套餐：对可归因费用乘账户倍率，或由请求级拟合直接覆盖单价</div>
<p class="callout"><strong>关键区别：</strong>“输入 token”不是一个桶。缓存命中的部分必须以供应商返回的 <code>cacheReadTokens</code> / <code>cache_read_input_tokens</code> 为准；重复 query 不能证明命中。输出 token 已包含 reasoning，不能再加一遍。</p>

<h2>本次样本的分项占比</h2>
${rows || '<p class="muted">还没有可归因请求。先运行 DSH 或把样例 ledger 放到 data/usage-ledger.jsonl。</p>'}

<h2>哪些变量会改变最终金额</h2>
<div class="flow">
<div class="flow-step"><b>上下文长度</b><span class="muted">输入和缓存读取分别计价；长上下文不是线性“看起来贵”，而是每个桶各自乘单价。</span></div>
<div class="flow-step"><b>缓存命中</b><span class="muted">命中后未缓存输入下降，但缓存读取仍收费；确切命中只能看 usage。</span></div>
<div class="flow-step"><b>思考/输出</b><span class="muted">reasoning 包含在 output tokens 中；真正影响金额的是最终 output token 数。</span></div>
<div class="flow-step"><b>峰谷时段</b><span class="muted">官方支持的模型在指定工作时段乘倍率；周末与节假日需单独验证。</span></div>
<div class="flow-step"><b>搜索/工具</b><span class="muted">搜索可能产生独立辅助模型请求和固定费，不能只按“工具调用次数”记账。</span></div>
</div>

<h2>当前支持的购买方式</h2>
<div class="grid">${profileCards}</div>
<table style="margin-top:16px">
<thead><tr><th>购买方式</th><th>费用形态</th><th>当前状态</th></tr></thead>
<tbody>
<tr><td>DeepSeek 官方 API</td><td>按量：输入/缓存/输出 + 可能的搜索费 + 峰谷倍率</td><td><strong>已填默认配置</strong>；搜索固定费待官方账单复核</td></tr>
<tr><td>OpenCode Go</td><td>控制台 list cost + 账户 allowance 折算</td><td><strong>已填账户观测系数</strong>；不同账户必须重新拟合</td></tr>
<tr><td>第三方代理/中转</td><td>通常只给聚合金额，可能有隐藏加价</td><td>可导入账单做总量系数拟合；分桶拟合需要请求级账单</td></tr>
<tr><td>自部署模型</td><td>GPU 小时、电力、运维、闲置率</td><td><strong>TODO</strong>：不把 token 单价硬套到自部署</td></tr>
</tbody></table>

<h2>请求级账单明细</h2>
<table>
<thead><tr><th>类型</th><th>时间</th><th>路由</th><th>状态</th><th>tokens / 数量</th><th>公开价</th><th>账单口径</th><th>未知项</th></tr></thead>
<tbody>${requestRows || '<tr><td colspan="8" class="muted">暂无请求记录。</td></tr>'}</tbody>
</table>

<h2>为什么要允许“用户自己的账单拟合”</h2>
<p>供应商公开价、控制台 list cost、套餐 allowance、促销折扣和实际扣款可能不是同一个口径。最可靠的做法不是把某个倍率写死，而是：</p>
<div class="flow">
<div class="flow-step"><b>1. 记录 usage</b><span class="muted">每次请求保存四个 token 桶、时间、模型和搜索次数。</span></div>
<div class="flow-step"><b>2. 导入账单</b><span class="muted">CSV/JSON/JSONL；请求级或聚合级都可以。</span></div>
<div class="flow-step"><b>3. 对账</b><span class="muted">先比较总额，再按请求 ID 或 session/turn/step 尝试逐条匹配。</span></div>
<div class="flow-step"><b>4. 拟合</b><span class="muted">样本少时拟合总倍率；请求级样本充足时拟合分桶单价。</span></div>
<div class="flow-step"><b>5. 留痕</b><span class="muted">价格档案写入样本数、方法、残差、验证状态，后续可审计。</span></div>
</div>

<p class="footer">数据源：usage=<code>${escapeHtml(context.usagePath)}</code>；search=<code>${escapeHtml(context.searchPath ?? '未提供')}</code>；bill=<code>${escapeHtml(context.billPath ?? '未提供')}</code>。生成时间 ${escapeHtml(new Date().toISOString())}。本报告是本地归因，不是供应商发票。</p>
</main></body></html>`
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      result[key] = true
    } else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function reportComponentKey(bucket) {
  return {
    uncachedInputTokens: 'uncachedInput',
    cacheReadTokens: 'cacheRead',
    cacheWriteTokens: 'cacheWrite',
    outputTokens: 'output',
  }[bucket]
}
