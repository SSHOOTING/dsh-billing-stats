import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { convertAmount } from './pricing.js'

const FIELD_ALIASES = Object.freeze({
  requestId: ['request_id', 'requestid', 'id', '请求id', '请求编号'],
  requestKey: ['request_key', 'requestkey', 'usage_key', '调用键'],
  sessionId: ['session_id', 'sessionid', '会话id', '会话'],
  turn: ['turn', '轮次'],
  step: ['step', '步骤'],
  provider: ['provider', '供应商', '服务商', '渠道'],
  model: ['model', '模型', 'model_name', '模型名称'],
  profile: ['profile', 'price_profile', '价格档案'],
  category: ['category', 'type', 'kind', '费用类型', '类别'],
  currency: ['currency', '币种'],
  amount: ['amount', 'cost', 'total_cost', '费用', '金额', '实际扣费', '账单金额'],
  inputTokens: ['input_tokens', 'uncached_input_tokens', 'prompt_tokens', '输入tokens', '输入token'],
  cacheReadTokens: ['cache_read_tokens', 'cache_read_input_tokens', 'cached_tokens', '缓存读取tokens', '缓存命中tokens'],
  cacheWriteTokens: ['cache_write_tokens', 'cache_creation_input_tokens', '缓存写入tokens'],
  outputTokens: ['output_tokens', 'completion_tokens', '输出tokens', '输出token'],
  searchRequests: ['search_requests', 'search_count', '搜索次数'],
  startedAt: ['started_at', 'time', 'timestamp', 'created_at', '请求时间', '时间'],
})

export function importBillFile(path, options = {}) {
  const document = parseBillDocument(path, options)
  return normalizeBillRecords(document, options)
}

export function parseBillDocument(path, options = {}) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')
  const format = options.format ?? inferFormat(path)
  if (format === 'json') return JSON.parse(text)
  if (format === 'jsonl') {
    return text.split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line))
  }
  if (format === 'csv') return parseCsv(text)
  throw new Error(`unsupported bill format: ${format}`)
}

export function normalizeBillRecords(document, options = {}) {
  const rows = Array.isArray(document)
    ? document
    : Array.isArray(document?.records)
      ? document.records
      : Array.isArray(document?.items)
        ? document.items
        : Array.isArray(document?.data)
          ? document.data
          : [document]
  const defaultCurrency = String(options.currency ?? document?.currency ?? 'CNY').toUpperCase()
  const displayCurrency = String(options.displayCurrency ?? 'CNY').toUpperCase()
  const usdToCny = Number(options.usdToCny ?? document?.usdToCny ?? 7.2)
  const records = []
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index] === null || typeof rows[index] !== 'object' || Array.isArray(rows[index])) {
      continue
    }
    const row = normalizeKeys(rows[index])
    const amount = numberAt(row, FIELD_ALIASES.amount)
    if (amount === undefined) continue
    const currency = String(pick(row, FIELD_ALIASES.currency) ?? defaultCurrency).toUpperCase()
    const displayAmount = convertAmount(amount, currency, displayCurrency, usdToCny)
    if (displayAmount === undefined) {
      throw new Error(`row ${index + 1}: unsupported currency ${currency}`)
    }
    const record = {
      schema: 'dsh.billing.bill.v1',
      sourceRow: index + 1,
      requestId: stringOrNull(pick(row, FIELD_ALIASES.requestId)),
      requestKey: stringOrNull(pick(row, FIELD_ALIASES.requestKey)),
      sessionId: stringOrNull(pick(row, FIELD_ALIASES.sessionId)),
      turn: integerOrNull(pick(row, FIELD_ALIASES.turn)),
      step: integerOrNull(pick(row, FIELD_ALIASES.step)),
      provider: stringOrNull(pick(row, FIELD_ALIASES.provider)),
      model: stringOrNull(pick(row, FIELD_ALIASES.model)),
      profile: stringOrNull(pick(row, FIELD_ALIASES.profile)),
      category: stringOrNull(pick(row, FIELD_ALIASES.category)) ?? 'model',
      currency,
      amount,
      amountMicros: Math.round(displayAmount * 1_000_000),
      displayCurrency,
      inputTokens: integerOrZero(pick(row, FIELD_ALIASES.inputTokens)),
      cacheReadTokens: integerOrZero(pick(row, FIELD_ALIASES.cacheReadTokens)),
      cacheWriteTokens: integerOrZero(pick(row, FIELD_ALIASES.cacheWriteTokens)),
      outputTokens: integerOrZero(pick(row, FIELD_ALIASES.outputTokens)),
      searchRequests: integerOrZero(pick(row, FIELD_ALIASES.searchRequests)),
      startedAt: stringOrNull(pick(row, FIELD_ALIASES.startedAt)),
    }
    record.level = record.requestId !== null
      || record.requestKey !== null
      || record.inputTokens > 0
      || record.outputTokens > 0
      || record.searchRequests > 0
      ? 'request'
      : 'aggregate'
    records.push(record)
  }
  return records
}

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/u, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/u, ''))
    rows.push(row)
  }
  if (rows.length === 0) return []
  const headers = rows[0].map(value => value.trim())
  return rows.slice(1)
    .filter(values => values.some(value => value.trim() !== ''))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])))
}

function inferFormat(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') return 'json'
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl'
  if (extension === '.csv' || extension === '.tsv') return 'csv'
  return 'csv'
}

function normalizeKeys(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.trim().toLowerCase().replace(/[\s-]+/gu, '_'),
      value,
    ]),
  )
}

function pick(row, aliases) {
  for (const alias of aliases) {
    const key = alias.toLowerCase().replace(/[\s-]+/gu, '_')
    if (Object.hasOwn(row, key) && row[key] !== '') return row[key]
  }
  return undefined
}

function numberAt(row, aliases) {
  const value = pick(row, aliases)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value.replace(/[¥$,\s]/gu, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

function integerOrZero(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/gu, ''))
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function integerOrNull(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}
