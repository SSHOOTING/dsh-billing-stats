import { readFileSync } from 'node:fs'

export const ZERO_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

const BUCKET_FIELDS = Object.freeze({
  uncachedInputTokens: 'input',
  cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite',
  outputTokens: 'output',
})

/**
 * Build a validated, immutable pricing catalog.
 *
 * The catalog intentionally separates:
 * - provider list rates;
 * - account/allowance multipliers;
 * - fit metadata and residuals.
 *
 * A missing rate is never silently converted to zero.
 *
 * @param {object} document
 * @returns {object}
 */
export function createPricingCatalog(document) {
  assertObject(document, 'pricing catalog')
  assertObject(document.profiles, 'pricing catalog.profiles')
  const displayCurrency = normalizeCurrency(document.displayCurrency ?? 'CNY')
  const usdToCny = finitePositive(document.usdToCny ?? 7.2)
    ?? throwType('usdToCny must be a finite positive number')
  const defaultProfile = typeof document.defaultProfile === 'string'
    ? document.defaultProfile
    : Object.keys(document.profiles)[0]
  if (!Object.hasOwn(document.profiles, defaultProfile)) {
    throw new TypeError(`defaultProfile is not defined: ${defaultProfile}`)
  }

  const profiles = new Map()
  for (const [profileId, rawProfile] of Object.entries(document.profiles)) {
    assertObject(rawProfile, `profile ${profileId}`)
    const models = new Map()
    const modelIds = new Set()
    for (const [modelId, rawModel] of Object.entries(rawProfile.models ?? {})) {
      assertObject(rawModel, `model ${profileId}/${modelId}`)
      modelIds.add(modelId)
      const model = {
        id: modelId,
        label: typeof rawModel.label === 'string' ? rawModel.label : modelId,
        input: optionalRate(rawModel.input),
        cacheRead: optionalRate(rawModel.cacheRead ?? rawModel.cache),
        cacheWrite: optionalRate(rawModel.cacheWrite),
        output: optionalRate(rawModel.output),
        peakMultiplier: optionalPositive(rawModel.peakMultiplier ?? rawProfile.peakMultiplier),
        peakTimeZone: String(rawModel.peakTimeZone ?? rawProfile.peakTimeZone ?? 'Asia/Shanghai'),
        peakWindows: normalizePeakWindows(rawModel.peakWindows ?? rawProfile.peakWindows),
        verified: rawModel.verified === true,
        source: typeof rawModel.source === 'string' ? rawModel.source : null,
        fit: isPlainObject(rawModel.fit) ? structuredClone(rawModel.fit) : null,
      }
      const aliases = new Set([
        modelId,
        ...(Array.isArray(rawModel.aliases) ? rawModel.aliases : []),
      ].filter(value => typeof value === 'string' && value.trim() !== ''))
      for (const alias of aliases) {
        models.set(normalizeModelKey(alias), model)
      }
    }

    const searchFees = new Map()
    for (const [key, rawFee] of Object.entries(rawProfile.searchFees ?? {})) {
      if (!isPlainObject(rawFee)) continue
      const perRequest = optionalRate(rawFee.perRequest)
      if (perRequest === undefined) continue
      searchFees.set(normalizeModelKey(key), {
        key,
        perRequest,
        currency: normalizeCurrency(rawFee.currency ?? rawProfile.currency ?? displayCurrency),
        verified: rawFee.verified === true,
        source: typeof rawFee.source === 'string' ? rawFee.source : null,
      })
    }

    profiles.set(profileId, {
      id: profileId,
      label: String(rawProfile.label ?? profileId),
      currency: normalizeCurrency(rawProfile.currency ?? displayCurrency),
      billingBasis: String(rawProfile.billingBasis ?? 'list-price'),
      accountMultiplier: finitePositive(rawProfile.accountMultiplier ?? 1)
        ?? throwType(`profile ${profileId}.accountMultiplier must be positive`),
      accountMultiplierSource: typeof rawProfile.accountMultiplierSource === 'string'
        ? rawProfile.accountMultiplierSource
        : null,
      searchMultiplier: finitePositive(rawProfile.searchMultiplier ?? 1)
        ?? throwType(`profile ${profileId}.searchMultiplier must be positive`),
      source: typeof rawProfile.source === 'string' ? rawProfile.source : null,
      verified: rawProfile.verified === true,
      fit: isPlainObject(rawProfile.fit) ? structuredClone(rawProfile.fit) : null,
      models,
      modelCount: modelIds.size,
      searchFees,
    })
  }

  const providerProfiles = new Map()
  for (const [provider, profileId] of Object.entries(document.providerProfiles ?? {})) {
    if (typeof profileId !== 'string' || !profiles.has(profileId)) continue
    providerProfiles.set(normalizeProvider(provider), profileId)
  }

  return {
    schemaVersion: Number(document.schemaVersion ?? 1),
    displayCurrency,
    usdToCny,
    defaultProfile,
    providerProfiles,
    profiles,
    version: String(document.version ?? document.sourceDate ?? 'unknown'),
  }
}

export function loadPricingCatalog(path) {
  return createPricingCatalog(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Choose a profile. `requested` may be "auto" or an explicit profile id.
 * Provider mappings win in auto mode; an explicit id is validated.
 */
export function chooseProfileId(catalog, provider, requested = 'auto') {
  const requestedId = typeof requested === 'string' && requested !== 'auto'
    ? requested
    : null
  if (requestedId !== null) {
    if (!catalog.profiles.has(requestedId)) {
      throw new TypeError(`unknown pricing profile: ${requestedId}`)
    }
    return requestedId
  }
  return catalog.providerProfiles.get(normalizeProvider(provider)) ?? catalog.defaultProfile
}

export function resolveModel(catalog, provider, model, requestedProfile = 'auto') {
  const profileId = chooseProfileId(catalog, provider, requestedProfile)
  const profile = catalog.profiles.get(profileId)
  const candidates = [
    normalizeModelKey(model),
    normalizeModelKey(`${provider}/${model}`),
    normalizeModelKey(String(model).split('/').at(-1)),
  ]
  for (const key of candidates) {
    if (key === '') continue
    const hit = profile.models.get(key)
    if (hit !== undefined) return { profileId, profile, model: hit }
  }
  return { profileId, profile, model: undefined }
}

export function normalizeUsage(usage) {
  if (!isPlainObject(usage)) return { ...ZERO_BUCKETS }
  const opencode = isPlainObject(usage.opencode?.tokens) ? usage.opencode.tokens : {}
  return {
    uncachedInputTokens: firstNonNegative(
      usage.uncachedInputTokens,
      usage.inputTokens,
      usage.input_tokens,
      opencode.input,
      opencode.uncachedInput,
    ) ?? 0,
    cacheReadTokens: firstNonNegative(
      usage.cacheReadTokens,
      usage.cache_read_input_tokens,
      usage.cache_read_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      opencode.cache_read,
      opencode.cacheRead,
    ) ?? 0,
    cacheWriteTokens: firstNonNegative(
      usage.cacheWriteTokens,
      usage.cache_creation_input_tokens,
      usage.cache_write_tokens,
      opencode.cache_write,
      opencode.cacheWrite,
    ) ?? 0,
    outputTokens: firstNonNegative(
      usage.outputTokens,
      usage.output_tokens,
      usage.completion_tokens,
      opencode.output,
    ) ?? 0,
  }
}

/**
 * Price one model response into list and billed micros.
 *
 * `outputTokens` already includes reasoning tokens. Callers must not add a
 * separate reasoning bucket.
 */
export function priceUsage(catalog, {
  provider,
  model,
  usage,
  profile = 'auto',
  at = null,
  requestKind = 'model',
}) {
  const buckets = normalizeUsage(usage)
  const resolved = resolveModel(catalog, provider, model, profile)
  const peak = peakState(at ?? Date.now(), resolved.model)
  const components = []
  const unknownComponents = []

  if (resolved.model === undefined) {
    for (const [bucket, tokens] of Object.entries(buckets)) {
      if (tokens > 0) unknownComponents.push(`model-price:${provider}/${model}:${bucket}`)
    }
    return result({
      provider,
      model,
      resolved,
      peak,
      buckets,
      components,
      unknownComponents,
      profile,
      requestKind,
      at,
    })
  }

  for (const [bucket, field] of Object.entries(BUCKET_FIELDS)) {
    const tokens = buckets[bucket]
    if (tokens === 0) continue
    const baseRate = resolved.model[field]
    if (baseRate === undefined) {
      unknownComponents.push(`rate:${bucket}`)
      continue
    }
    const effectiveRate = baseRate * peak.multiplier
    const listMicros = rateToDisplayMicros(
      tokens,
      effectiveRate,
      resolved.profile.currency,
      catalog.displayCurrency,
      catalog.usdToCny,
    )
    if (listMicros === undefined) {
      unknownComponents.push(`currency:${bucket}`)
      continue
    }
    components.push({
      kind: 'token',
      bucket,
      tokens,
      ratePer1M: effectiveRate,
      rateCurrency: resolved.profile.currency,
      peakMultiplier: peak.multiplier,
      listMicros,
      billedMicros: Math.round(listMicros * resolved.profile.accountMultiplier),
    })
  }

  return result({
    provider,
    model,
    resolved,
    peak,
    buckets,
    components,
    unknownComponents,
    profile,
    requestKind,
    at,
  })
}

/**
 * Price one search-ledger record.
 *
 * Search ledgers from the shim contain provider attempts with raw usage. We
 * re-price those raw buckets through the active catalog instead of trusting a
 * possibly stale rate card embedded by the shim. Search fixed fees are added
 * once per attempt that reports a positive search count.
 */
export function priceSearchLedgerRecord(catalog, record, { profile = 'auto', at = null } = {}) {
  assertObject(record, 'search ledger record')
  const attempts = Array.isArray(record.attempts) ? record.attempts : []
  const components = []
  const unknownComponents = []
  let profileId = null

  for (const attempt of attempts) {
    const provider = inferSearchProvider(attempt, record)
    const model = typeof attempt.model === 'string' ? attempt.model : ''
    const usageNotApplicable = attempt.usageNotApplicable === true
    if (!usageNotApplicable) {
      const priced = priceUsage(catalog, {
        provider,
        model,
        usage: attempt.usage,
        profile,
        at: attempt.startedAt ?? record.startedAt ?? at,
        requestKind: 'search-attempt',
      })
      profileId = priced.profileId
      components.push(...priced.components.map(component => ({
        ...component,
        category: 'search-token',
        model,
        provider,
      })))
      unknownComponents.push(...priced.unknownComponents.map(value => `search:${value}`))
    }

    const searchRequests = firstNonNegativeInteger(attempt.searchRequests)
    if (searchRequests !== undefined && searchRequests > 0) {
      const feeKey = attempt.fixedFeeKey ?? inferSearchFeeKey(attempt, record)
      const feeProfileId = chooseProfileId(catalog, provider, profile)
      const feeProfile = catalog.profiles.get(feeProfileId)
      const fee = feeProfile.searchFees.get(normalizeModelKey(feeKey))
      profileId = profileId ?? feeProfileId
      if (fee === undefined) {
        unknownComponents.push(`search-fee:${feeKey}`)
      } else {
        const listMicros = amountToDisplayMicros(
          searchRequests * fee.perRequest,
          fee.currency,
          catalog.displayCurrency,
          catalog.usdToCny,
        )
        if (listMicros === undefined) {
          unknownComponents.push(`search-fee-currency:${fee.currency}`)
        } else {
          components.push({
            kind: 'fixed-search-fee',
            category: 'search-fee',
            searchRequests,
            feeKey,
            listMicros,
            billedMicros: Math.round(listMicros * feeProfile.searchMultiplier),
            verified: fee.verified,
          })
        }
      }
    }
  }

  if (attempts.length === 0) {
    const fallback = firstNonNegative(record.cost?.knownTotalMicros)
    if (fallback === undefined || fallback === 0) {
      unknownComponents.push('search-ledger:missing-usage')
    } else {
      const feeProfileId = chooseProfileId(catalog, 'opencode-go', profile)
      const feeProfile = catalog.profiles.get(feeProfileId)
      profileId = feeProfileId
      components.push({
        kind: 'legacy-search-cost',
        category: 'search',
        listMicros: fallback,
        billedMicros: Math.round(fallback * feeProfile.searchMultiplier),
      })
    }
  }

  const listMicros = components.reduce((sum, component) => sum + component.listMicros, 0)
  const billedMicros = components.reduce((sum, component) => sum + component.billedMicros, 0)
  return {
    profileId,
    status: unknownComponents.length === 0 ? 'priced' : listMicros > 0 ? 'partial' : 'unknown',
    listMicros,
    billedMicros,
    components,
    unknownComponents,
    ledgerId: typeof record.ledgerId === 'string' ? record.ledgerId : null,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    actualSearchRequests: firstNonNegativeInteger(record.actualSearchRequests) ?? 0,
  }
}

export function formatMoney(micros, currency = 'CNY') {
  const amount = Math.max(0, Number.isFinite(micros) ? micros : 0) / 1_000_000
  const digits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6
  return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(digits)}`
}

export function peakState(at, model) {
  if (model?.peakMultiplier === undefined || model.peakMultiplier <= 1) {
    return { multiplier: 1, isPeak: false, localDate: null, localHour: null, weekday: null }
  }
  const date = at instanceof Date ? at : new Date(at ?? Date.now())
  if (Number.isNaN(date.getTime())) {
    return { multiplier: 1, isPeak: false, localDate: null, localHour: null, weekday: null }
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: model.peakTimeZone ?? 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date).map(part => [part.type, part.value]))
  const localHour = Number(parts.hour) % 24
  const localDate = `${parts.year}-${parts.month}-${parts.day}`
  const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun'
  const isPeak = !isWeekend
    && (model.peakWindows ?? []).some(([start, end]) => localHour >= start && localHour < end)
  return {
    multiplier: isPeak ? model.peakMultiplier : 1,
    isPeak,
    localDate,
    localHour,
    weekday: parts.weekday,
  }
}

export function rateToDisplayMicros(tokens, ratePerMillion, rateCurrency, displayCurrency, usdToCny) {
  const converted = convertAmount(ratePerMillion, rateCurrency, displayCurrency, usdToCny)
  return converted === undefined ? undefined : Math.round(tokens * converted)
}

export function amountToDisplayMicros(amount, amountCurrency, displayCurrency, usdToCny) {
  const converted = convertAmount(amount, amountCurrency, displayCurrency, usdToCny)
  return converted === undefined ? undefined : Math.round(converted * 1_000_000)
}

export function convertAmount(amount, fromCurrency, toCurrency, usdToCny) {
  if (!Number.isFinite(amount)) return undefined
  const from = normalizeCurrency(fromCurrency)
  const to = normalizeCurrency(toCurrency)
  if (from === to) return amount
  if (from === 'USD' && to === 'CNY') return amount * usdToCny
  if (from === 'CNY' && to === 'USD') return amount / usdToCny
  return undefined
}

export function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  }
}

export function subtractBuckets(left, right) {
  return {
    uncachedInputTokens: Math.max(0, left.uncachedInputTokens - right.uncachedInputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
  }
}

export function hasAnyBuckets(buckets) {
  return Object.values(buckets).some(value => value > 0)
}

function result({
  provider,
  model,
  resolved,
  peak,
  buckets,
  components,
  unknownComponents,
  profile,
  requestKind,
  at,
}) {
  const listMicros = components.reduce((sum, component) => sum + component.listMicros, 0)
  const billedMicros = components.reduce((sum, component) => sum + component.billedMicros, 0)
  return {
    profileId: resolved.profileId,
    profileLabel: resolved.profile.label,
    billingBasis: resolved.profile.billingBasis,
    modelId: resolved.model?.id ?? null,
    provider: provider ?? null,
    model: model ?? null,
    requestKind,
    at: at === null || at === undefined ? null : new Date(at).toISOString(),
    peak,
    buckets,
    components,
    unknownComponents,
    listMicros,
    billedMicros,
    status: unknownComponents.length === 0 ? 'priced' : listMicros > 0 ? 'partial' : 'unknown',
    accountMultiplier: resolved.profile.accountMultiplier,
    pricingVerified: resolved.profile.verified && (resolved.model?.verified ?? false),
    profile,
  }
}

function inferSearchProvider(attempt, record) {
  if (typeof attempt.provider === 'string' && attempt.provider.trim() !== '') {
    return attempt.provider
  }
  const engine = `${attempt.engine ?? ''} ${record.mode ?? ''}`.toLowerCase()
  if (engine.includes('deepseek')) return 'deepseek'
  return 'opencode-go'
}

function inferSearchFeeKey(attempt, record) {
  // The current shim uses DeepSeek's dedicated search tool on both routes when
  // fallback occurs. Unknown engines still resolve to this explicit key so the
  // source of a missing rate remains visible.
  return `${attempt.engine ?? record.mode ?? 'deepseek-tools-search'}`.includes('deepseek')
    ? 'deepseek-tools-search'
    : 'deepseek-tools-search'
}

function optionalRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function optionalPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function finitePositive(value) {
  return optionalPositive(value)
}

function firstNonNegative(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

function firstNonNegativeInteger(...values) {
  const value = firstNonNegative(...values)
  return value === undefined ? undefined : Math.trunc(value)
}

function normalizeModelKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/gu, ' ')
}

function normalizeProvider(value) {
  return String(value ?? '').trim().toLowerCase()
}

function normalizeCurrency(value) {
  const currency = String(value ?? '').trim().toUpperCase()
  if (currency !== 'CNY' && currency !== 'USD') {
    throw new TypeError(`unsupported currency: ${String(value)}`)
  }
  return currency
}

function normalizePeakWindows(value) {
  if (!Array.isArray(value)) return []
  return value.map((window) => {
    if (!Array.isArray(window) || window.length !== 2) return null
    const start = parseHour(window[0])
    const end = parseHour(window[1])
    return start === undefined || end === undefined || start >= end ? null : [start, end]
  }).filter(Boolean)
}

function parseHour(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value < 24 ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2})(?::00)?$/u.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : undefined
}

function assertObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function throwType(message) {
  throw new TypeError(message)
}
