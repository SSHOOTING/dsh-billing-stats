/**
 * Search-side accounting primitives for the DSH OpenCode search shim.
 *
 * This module deliberately separates:
 * - observed provider usage (what the API actually reported),
 * - price assumptions (editable, versioned, and allowed to be unknown),
 * - estimated cost (never called an invoice).
 *
 * A missing usage object or a missing rate never becomes a zero-cost success.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SEARCH_LEDGER_SCHEMA = 'dsh.search-ledger.v1'

const ZERO_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

const BUCKET_FIELDS = Object.freeze({
  uncachedInputTokens: 'inputPer1M',
  cacheReadTokens: 'cacheReadPer1M',
  cacheWriteTokens: 'cacheWritePer1M',
  outputTokens: 'outputPer1M',
})

const BUCKET_ALIASES = Object.freeze({
  uncachedInputTokens: [
    'uncachedInputTokens',
    'inputTokens',
    'input_tokens',
    'prompt_tokens',
  ],
  cacheReadTokens: [
    'cacheReadTokens',
    'cache_read_input_tokens',
    'cache_read_tokens',
    'prompt_tokens_details.cached_tokens',
  ],
  cacheWriteTokens: [
    'cacheWriteTokens',
    'cache_creation_input_tokens',
    'cache_write_tokens',
  ],
  outputTokens: [
    'outputTokens',
    'output_tokens',
    'completion_tokens',
  ],
})

/**
 * Stable JSON serialization used only for request fingerprints. Object key order
 * must not change correlation.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * SHA-256 of the exact secret-free Messages request body. DSH already records
 * this body in `web/deepseek-search-llm-request`; the shim can compute the same
 * value without receiving a session or tool-call id.
 *
 * @param {unknown} requestBody
 * @returns {string}
 */
export function fingerprintSearchRequest(requestBody) {
  return createHash('sha256').update(canonicalJson(requestBody)).digest('hex')
}

/**
 * Normalize Anthropic/OpenAI-ish usage into four disjoint token buckets.
 *
 * Anthropic `input_tokens` excludes both cache-read and cache-write tokens.
 * DSH's 0.2 `inputTokens` also means uncached input. OpenAI `prompt_tokens`
 * may include cached tokens, so callers that know that shape should pass
 * `{ inputIncludesCacheRead: true }`.
 *
 * @param {object|null|undefined} usage
 * @param {{inputIncludesCacheRead?: boolean}} [options]
 * @returns {{
 *   status: 'reported'|'missing',
 *   raw: object|null,
 *   buckets: {uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number},
 *   reportedTotalInputTokens: number|null
 * }}
 */
export function normalizeSearchUsage(usage, options = {}) {
  if (usage === null || usage === undefined || typeof usage !== 'object' || Array.isArray(usage)) {
    return {
      status: 'missing',
      raw: null,
      buckets: { ...ZERO_BUCKETS },
      reportedTotalInputTokens: null,
    }
  }

  const rawCacheRead = firstFiniteNonNegative([
    usage.cacheReadTokens,
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    getPath(usage, 'prompt_tokens_details.cached_tokens'),
  ])
  let rawInput = firstFiniteNonNegative([
    usage.uncachedInputTokens,
    usage.inputTokens,
    usage.input_tokens,
    usage.prompt_tokens,
  ])
  const cacheReadTokens = rawCacheRead ?? 0
  const reportedTotalInputTokens = firstFiniteNonNegative([
    usage.totalInputTokens,
    usage.total_input_tokens,
    usage.totalTokens,
    usage.total_tokens,
  ])
  if (rawInput !== undefined && options.inputIncludesCacheRead === true) {
    rawInput = Math.max(0, rawInput - cacheReadTokens)
  }

  return {
    status: 'reported',
    raw: sanitizeUsageObject(usage),
    buckets: {
      uncachedInputTokens: rawInput ?? 0,
      cacheReadTokens,
      cacheWriteTokens: firstFiniteNonNegative([
        usage.cacheWriteTokens,
        usage.cache_creation_input_tokens,
        usage.cache_write_tokens,
      ]) ?? 0,
      outputTokens: firstFiniteNonNegative([
        usage.outputTokens,
        usage.output_tokens,
        usage.completion_tokens,
      ]) ?? 0,
    },
    reportedTotalInputTokens: reportedTotalInputTokens ?? null,
  }
}

/**
 * Is an instant in DeepSeek's peak-priced window? Beijing time by default.
 * Holidays are explicit configuration: without a holiday list this function
 * must not pretend it knows Chinese statutory holidays.
 *
 * @param {number|string|Date} at
 * @param {{
 *   timeZone?: string,
 *   windows?: Array<[number, number]>,
 *   holidays?: string[],
 *   weekendOffPeak?: boolean
 * }} [config]
 * @returns {{isPeak: boolean, localDate: string, localHour: number, weekday: string, reason: string}}
 */
export function peakState(at, config = {}) {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) throw new TypeError('peakState: invalid timestamp')
  const timeZone = config.timeZone ?? 'Asia/Shanghai'
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date).map(part => [part.type, part.value]))
  const localDate = `${parts.year}-${parts.month}-${parts.day}`
  const localHour = Number(parts.hour) % 24
  const weekday = parts.weekday
  if (config.holidays?.includes(localDate)) {
    return { isPeak: false, localDate, localHour, weekday, reason: 'holiday' }
  }
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { isPeak: false, localDate, localHour, weekday, reason: 'weekend' }
  }
  const windows = config.windows ?? [[9, 12], [14, 18]]
  const isPeak = windows.some(([start, end]) => localHour >= start && localHour < end)
  return {
    isPeak,
    localDate,
    localHour,
    weekday,
    reason: isPeak ? 'weekday-peak-window' : 'weekday-off-peak-window',
  }
}

/**
 * Build a validated price card. Unknown rates must be omitted or null; they
 * must not be supplied as 0 unless the provider genuinely bills zero.
 *
 * @param {object} document
 * @returns {object}
 */
export function createSearchPriceCard(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('price card must be an object')
  }
  if (document.models === null || typeof document.models !== 'object' || Array.isArray(document.models)) {
    throw new TypeError('price card requires a models object')
  }
  if (document.fixedFees !== undefined
    && (document.fixedFees === null || typeof document.fixedFees !== 'object' || Array.isArray(document.fixedFees))) {
    throw new TypeError('price card fixedFees must be an object')
  }
  const models = {}
  for (const [key, value] of Object.entries(document.models)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    models[key] = {
      currency: String(value.currency ?? document.currency ?? 'USD').toUpperCase(),
      inputPer1M: finiteNonNegative(value.inputPer1M ?? value.input),
      outputPer1M: finiteNonNegative(value.outputPer1M ?? value.output),
      cacheReadPer1M: finiteNonNegative(value.cacheReadPer1M ?? value.cache),
      cacheWritePer1M: finiteNonNegative(value.cacheWritePer1M ?? value.cacheWrite),
      peakMultiplier: finitePositive(value.peakMultiplier),
      verified: value.verified === true,
      source: typeof value.source === 'string' ? value.source : null,
    }
  }
  const fixedFees = {}
  for (const [key, value] of Object.entries(document.fixedFees ?? {})) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    fixedFees[key] = {
      currency: String(value.currency ?? document.currency ?? 'USD').toUpperCase(),
      perSearchRequest: finiteNonNegative(value.perSearchRequest),
      verified: value.verified === true,
      source: typeof value.source === 'string' ? value.source : null,
    }
  }
  return {
    version: String(document.version ?? 'unknown'),
    source: typeof document.source === 'string' ? document.source : null,
    displayCurrency: String(document.displayCurrency ?? 'CNY').toUpperCase(),
    usdToCny: finitePositive(document.usdToCny) ?? 7.2,
    peak: {
      timeZone: String(document.peak?.timeZone ?? 'Asia/Shanghai'),
      windows: Array.isArray(document.peak?.windows)
        ? document.peak.windows.map(window => [Number(window[0]), Number(window[1])])
        : [[9, 12], [14, 18]],
      holidays: Array.isArray(document.peak?.holidays)
        ? document.peak.holidays.filter(value => typeof value === 'string')
        : [],
    },
    models,
    fixedFees,
  }
}

/**
 * Price one provider attempt. The result's `totalMicros` is only a complete
 * estimate when `status === 'priced'`.
 *
 * @param {object} attempt
 * @param {object} priceCard
 * @returns {object}
 */
export function priceSearchAttempt(attempt, priceCard) {
  const usage = normalizeSearchUsage(
    attempt.usage,
    { inputIncludesCacheRead: attempt.inputIncludesCacheRead === true },
  )
  const displayCurrency = priceCard.displayCurrency
  const usdToCny = priceCard.usdToCny
  const modelKey = attempt.priceKey
    ?? [attempt.provider, attempt.model].filter(Boolean).join('/')
    ?? ''
  const model = priceCard.models[modelKey]
    ?? priceCard.models[attempt.model]
    ?? null
  const attemptPeak = peakState(attempt.startedAt ?? Date.now(), priceCard.peak)
  const unknownComponents = []
  const components = []

  if (usage.status === 'missing' && attempt.usageNotApplicable !== true) {
    unknownComponents.push('usage')
  } else if (usage.status === 'reported' && model === null) {
    if (hasAnyBuckets(usage.buckets)) unknownComponents.push('model-price:' + (modelKey || 'unknown'))
  } else {
    for (const [bucket, field] of Object.entries(BUCKET_FIELDS)) {
      const tokens = usage.buckets[bucket]
      if (tokens === 0) continue
      const rate = model[field]
      const peakAwareRate = rate === undefined || model.peakMultiplier === undefined || !attemptPeak.isPeak
        ? rate
        : rate * model.peakMultiplier
      const micros = rate === undefined
        ? undefined
        : rateToDisplayMicros(tokens, peakAwareRate, model.currency, displayCurrency, usdToCny)
      if (micros === undefined) {
        unknownComponents.push('rate:' + bucket)
        continue
      }
      components.push({
        kind: 'token',
        bucket,
        tokens,
        amountMicros: micros,
        currency: displayCurrency,
      })
    }
  }

  const fixedKey = attempt.fixedFeeKey ?? attempt.engine
  const fixedFee = priceCard.fixedFees[fixedKey]
  if (fixedFee !== undefined) {
    const searchRequests = finiteNonNegativeInteger(attempt.searchRequests)
    if (searchRequests === undefined) {
      unknownComponents.push('fixed-fee-search-count')
    } else if (searchRequests > 0) {
      const micros = fixedFee.perSearchRequest === undefined
        ? undefined
        : amountToDisplayMicros(
          searchRequests * fixedFee.perSearchRequest,
          fixedFee.perSearchRequest,
          fixedFee.currency,
          displayCurrency,
          usdToCny,
        )
      if (micros === undefined) unknownComponents.push('fixed-fee-rate')
      else {
        components.push({
          kind: 'fixed-search-fee',
          searchRequests,
          amountMicros: micros,
          currency: displayCurrency,
        })
      }
    }
  }

  const knownMicros = components.reduce((sum, component) => sum + component.amountMicros, 0)
  const status = unknownComponents.length === 0
    ? 'priced'
    : components.length === 0
      ? 'unknown'
      : 'partial'
  return {
    engine: attempt.engine ?? null,
    kind: attempt.kind ?? null,
    model: attempt.model ?? null,
    provider: attempt.provider ?? null,
    status: attempt.status ?? null,
    httpStatus: attempt.httpStatus ?? null,
    startedAt: attempt.startedAt ?? null,
    endedAt: attempt.endedAt ?? null,
    durationMs: finiteNonNegative(attempt.durationMs) ?? null,
    searchRequests: finiteNonNegativeInteger(attempt.searchRequests) ?? null,
    searchRequestsSource: attempt.searchRequestsSource ?? 'unknown',
    usageStatus: usage.status,
    usageNotApplicable: attempt.usageNotApplicable === true,
    usage: usage.buckets,
    usageRaw: usage.raw,
    pricing: {
      status,
      knownCostMicros: knownMicros,
      unknownComponents,
      components,
      priceCardVersion: priceCard.version,
      modelVerified: model?.verified ?? false,
      fixedFeeVerified: fixedFee?.verified ?? false,
      peakMultiplier: model?.peakMultiplier ?? null,
      peakApplied: model?.peakMultiplier !== undefined && attemptPeak.isPeak,
    },
    error: attempt.error ?? null,
  }
}

/**
 * Create one immutable ledger record for one shim HTTP request (one query).
 *
 * @param {{
 *   startedAt: number|string|Date,
 *   endedAt: number|string|Date,
 *   mode: string,
 *   query: string,
 *   requestBody: unknown,
 *   attempts: object[],
 *   priceCard: object,
 *   correlation?: {requestId?: string|null, sessionId?: string|null, toolCallId?: string|null},
 *   redactQuery?: boolean,
 *   ledgerId?: string
 * }} input
 * @returns {object}
 */
export function createSearchLedgerRecord(input) {
  const startedAtMs = toEpochMs(input.startedAt)
  const endedAtMs = toEpochMs(input.endedAt)
  const priceCard = input.priceCard
  const attempts = input.attempts.map(attempt => priceSearchAttempt({
    startedAt: input.startedAt,
    ...attempt,
  }, priceCard))
  const knownCostMicros = attempts.reduce(
    (sum, attempt) => sum + attempt.pricing.knownCostMicros,
    0,
  )
  const status = attempts.length > 0 && attempts.every(attempt => attempt.pricing.status === 'priced')
    ? 'priced'
    : attempts.some(attempt => attempt.pricing.knownCostMicros > 0)
      ? 'partial'
      : 'unknown'
  const cache = sumBuckets(attempts.map(attempt => attempt.usage))
  const searchRequestValues = attempts
    .map(attempt => attempt.searchRequests)
    .filter(value => value !== null)
  const actualSearchRequests = searchRequestValues.reduce((sum, value) => sum + value, 0)
  const searchRequestsKnown = attempts.every(attempt => attempt.searchRequests !== null)
  return {
    schema: SEARCH_LEDGER_SCHEMA,
    ledgerId: input.ledgerId ?? randomUUID(),
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    mode: input.mode,
    query: input.redactQuery === true ? null : String(input.query ?? ''),
    queryHash: sha256(String(input.query ?? '')),
    requestFingerprint: fingerprintSearchRequest(input.requestBody),
    correlation: {
      requestId: input.correlation?.requestId ?? null,
      sessionId: input.correlation?.sessionId ?? null,
      toolCallId: input.correlation?.toolCallId ?? null,
    },
    peak: peakState(startedAtMs, priceCard.peak),
    attempts,
    cache,
    actualSearchRequests,
    searchRequestsKnown,
    cost: {
      status,
      currency: priceCard.displayCurrency,
      knownTotalMicros: knownCostMicros,
      complete: status === 'priced',
      priceCardVersion: priceCard.version,
    },
  }
}

/**
 * Append one complete JSON line and flush it before returning. O_APPEND keeps
 * concurrent shim requests from interleaving bytes.
 *
 * @param {string} filePath
 * @param {object} record
 */
export function appendSearchLedgerRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const line = JSON.stringify(record) + '\n'
  const fd = fs.openSync(filePath, 'a')
  try {
    fs.writeFileSync(fd, line, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read only complete newline-terminated records. A torn final line is left for
 * the next poll and does not advance the cursor.
 *
 * @param {string} filePath
 * @param {number} [offset]
 * @param {{limit?: number}} [options]
 * @returns {{records: object[], nextOffset: number, skipped: object[], tornTail: boolean}}
 */
export function readSearchLedgerSince(filePath, offset = 0, options = {}) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], nextOffset: 0, skipped: [], tornTail: false }
    throw error
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) {
    throw new RangeError('ledger offset is outside the file')
  }
  const limit = options.limit ?? 1000
  const buffer = Buffer.alloc(stat.size - offset)
  if (buffer.length === 0) return { records: [], nextOffset: offset, skipped: [], tornTail: false }
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buffer, 0, buffer.length, offset)
  } finally {
    fs.closeSync(fd)
  }
  const lastNewline = buffer.lastIndexOf(0x0a)
  if (lastNewline < 0) {
    return { records: [], nextOffset: offset, skipped: [], tornTail: true }
  }
  const complete = buffer.subarray(0, lastNewline + 1).toString('utf8')
  const records = []
  const skipped = []
  let consumedBytes = 0
  for (const [index, line] of complete.split('\n').entries()) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (index < complete.split('\n').length - 1 ? 1 : 0)
    if (line.trim() === '') {
      consumedBytes += lineBytes
      continue
    }
    if (records.length >= limit) break
    try {
      const record = JSON.parse(line)
      if (record?.schema !== SEARCH_LEDGER_SCHEMA) {
        skipped.push({ index, reason: 'schema' })
        consumedBytes += lineBytes
        continue
      }
      records.push(record)
      consumedBytes += lineBytes
    } catch {
      skipped.push({ index, reason: 'json' })
      consumedBytes += lineBytes
    }
  }
  return {
    records,
    nextOffset: offset + consumedBytes,
    skipped,
    tornTail: consumedBytes < buffer.length,
  }
}

/**
 * Correlate DSH's already-recorded `web/deepseek-search-llm-request` events
 * with shim ledger records. Exact fingerprint plus FIFO is the MVP; an explicit
 * request id header is the collision-proof upgrade.
 */
export class SearchLedgerConsumer {
  constructor({ ledgerPath, offset = 0, maxPendingAgeMs = 10 * 60 * 1000 }) {
    this.ledgerPath = ledgerPath
    this.offset = offset
    this.maxPendingAgeMs = maxPendingAgeMs
    this.pending = []
    this.seenLedgerIds = new Set()
  }

  /**
   * Register the body DSH is about to send. Call this from the session event
   * hook while the guard still knows the current turn/step.
   */
  expectRequest({ body, sessionId, turn, step, requestId = null, at = Date.now() }) {
    const expectation = {
      sequence: this.pending.length === 0
        ? 1
        : Math.max(...this.pending.map(item => item.sequence)) + 1,
      fingerprint: fingerprintSearchRequest(body),
      sessionId,
      turn,
      step,
      requestId,
      createdAt: toEpochMs(at),
    }
    this.pending.push(expectation)
    return expectation
  }

  /**
   * Read newly appended ledger lines and match them to pending expectations.
   * Unmatched lines are returned, never silently dropped.
   */
  poll({ at = Date.now(), limit = 1000 } = {}) {
    const read = readSearchLedgerSince(this.ledgerPath, this.offset, { limit })
    this.offset = read.nextOffset
    const settlements = []
    const unmatched = []
    for (const record of read.records) {
      if (this.seenLedgerIds.has(record.ledgerId)) continue
      this.seenLedgerIds.add(record.ledgerId)
      const matchIndex = this.findMatch(record)
      if (matchIndex < 0) {
        unmatched.push(record)
        continue
      }
      const [expectation] = this.pending.splice(matchIndex, 1)
      settlements.push(settlementOf(expectation, record))
    }
    const cutoff = toEpochMs(at) - this.maxPendingAgeMs
    this.pending = this.pending.filter(expectation => expectation.createdAt >= cutoff)
    return {
      settlements,
      unmatched,
      skipped: read.skipped,
      tornTail: read.tornTail,
      nextOffset: this.offset,
      pending: [...this.pending],
    }
  }

  findMatch(record) {
    const recordStart = toEpochMs(record.startedAt)
    if (record.correlation?.requestId) {
      const exact = this.pending.findIndex(expectation =>
        expectation.requestId === record.correlation.requestId)
      if (exact >= 0) return exact
    }
    return this.pending.findIndex((expectation) => {
      if (expectation.fingerprint !== record.requestFingerprint) return false
      return recordStart >= expectation.createdAt - 5000
    })
  }
}

/**
 * Projection-friendly settlement. The host budget guard should add
 * `costMicros` to the named turn and propagate `unknownCost` into its
 * "unknown prior usage" gate.
 */
function settlementOf(expectation, record) {
  return {
    eventId: record.ledgerId,
    sessionId: expectation.sessionId,
    turn: expectation.turn,
    step: expectation.step,
    ledgerId: record.ledgerId,
    costMicros: record.cost.knownTotalMicros,
    currency: record.cost.currency,
    costStatus: record.cost.status,
    priced: record.cost.complete,
    unknownCost: !record.cost.complete,
    actualSearchRequests: record.actualSearchRequests,
    cache: record.cache,
    peak: record.peak,
    queryHash: record.queryHash,
  }
}

function firstFiniteNonNegative(values) {
  for (const value of values) {
    const normalized = finiteNonNegative(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function finiteNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function rateToDisplayMicros(tokens, ratePerMillion, sourceCurrency, displayCurrency, usdToCny) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(ratePerMillion) || ratePerMillion < 0) {
    return undefined
  }
  let converted = ratePerMillion
  if (sourceCurrency !== displayCurrency) {
    if (sourceCurrency === 'USD' && displayCurrency === 'CNY') converted *= usdToCny
    else if (sourceCurrency === 'CNY' && displayCurrency === 'USD') converted /= usdToCny
    else return undefined
  }
  // tokens × (display currency per 1M) = display micros.
  return Math.round(tokens * converted)
}

function amountToDisplayMicros(amount, _ratePerMillion, sourceCurrency, displayCurrency, usdToCny) {
  if (!Number.isFinite(amount) || amount < 0) return undefined
  let converted = amount
  if (sourceCurrency !== displayCurrency) {
    if (sourceCurrency === 'USD' && displayCurrency === 'CNY') converted *= usdToCny
    else if (sourceCurrency === 'CNY' && displayCurrency === 'USD') converted /= usdToCny
    else return undefined
  }
  return Math.round(converted * 1_000_000)
}

function hasAnyBuckets(buckets) {
  return Object.values(buckets).some(value => value > 0)
}

function sumBuckets(bucketsList) {
  return bucketsList.reduce((sum, buckets) => ({
    uncachedInputTokens: sum.uncachedInputTokens + buckets.uncachedInputTokens,
    cacheReadTokens: sum.cacheReadTokens + buckets.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + buckets.cacheWriteTokens,
    outputTokens: sum.outputTokens + buckets.outputTokens,
  }), { ...ZERO_BUCKETS })
}

function sanitizeUsageObject(value, depth = 0) {
  if (depth > 3 || value === null || typeof value !== 'object') {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
      ? value
      : null
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeUsageObject(item, depth + 1))
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)$/iu.test(key)) continue
    out[key] = sanitizeUsageObject(child, depth + 1)
  }
  return out
}

function getPath(value, dottedPath) {
  let current = value
  for (const key of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function toEpochMs(value) {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value))
  if (!Number.isFinite(ms)) throw new TypeError(`invalid timestamp: ${String(value)}`)
  return ms
}
