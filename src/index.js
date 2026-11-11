/**
 * Billing attribution host half.
 *
 * This plugin is deliberately observational:
 * - it never rewrites the model request;
 * - it never caps maxTokens;
 * - it never blocks a request or tool call;
 * - it never adds a model-visible prompt section.
 */
import { fileURLToPath } from 'node:url'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  BILLING_PROJECTION_KEY,
  BILLING_STATE_VERSION,
  applyBillingEvent,
  billingStateSchema,
  billingView,
  billingViewSchema,
  initBillingState,
  parseCostCommand,
  renderBillingSummary,
  renderLastRequest,
  renderProfiles,
} from './ledger.js'
import {
  chooseProfileId,
  loadPricingCatalog,
  normalizeUsage,
  priceSearchLedgerRecord,
  priceUsage,
} from './pricing.js'
import {
  initHostSearchLedgerState,
  observeSearchRequest,
  pollHostSearchLedger,
  turnSearchSummary,
} from './host-search-ledger.js'

export const name = 'billing-attribution'
export const inject = ['commands', 'sessionProjections']

const DEFAULT_PRICING_PATH = fileURLToPath(new URL('../pricing/profiles.json', import.meta.url))
const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../data/usage-ledger.jsonl', import.meta.url))
const DEFAULT_SEARCH_STATE_PATH = fileURLToPath(new URL('../data/search-state.json', import.meta.url))
const DEFAULT_SEARCH_LEDGER_PATH = 'E:\\programs\\deepseed_harness\\opencode-search-shim\\search-ledger.jsonl'

export function resolveConfig(config = {}) {
  const displayCurrency = String(config.displayCurrency ?? 'CNY').toUpperCase()
  if (displayCurrency !== 'CNY' && displayCurrency !== 'USD') {
    throw new Error('billing-attribution: displayCurrency must be CNY or USD')
  }
  return {
    displayCurrency,
    pricingPath: nonEmptyString(config.pricingPath) ?? DEFAULT_PRICING_PATH,
    ledgerPath: nonEmptyString(config.ledgerPath) ?? DEFAULT_LEDGER_PATH,
    searchLedgerEnabled: config.searchLedgerEnabled !== false,
    searchLedgerPath: nonEmptyString(config.searchLedgerPath) ?? DEFAULT_SEARCH_LEDGER_PATH,
    searchStatePath: nonEmptyString(config.searchStatePath) ?? DEFAULT_SEARCH_STATE_PATH,
    activeProfile: nonEmptyString(config.activeProfile) ?? 'auto',
    maxRecentRequests: safeIntegerAtLeast(config.maxRecentRequests ?? 20, 1, 'maxRecentRequests'),
  }
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const pricing = loadPricingCatalog(resolved.pricingPath)
  if (pricing.displayCurrency !== resolved.displayCurrency) {
    throw new Error(
      `billing-attribution: config displayCurrency ${resolved.displayCurrency} `
      + `does not match pricing catalog ${pricing.displayCurrency}`,
    )
  }
  if (resolved.activeProfile !== 'auto' && !pricing.profiles.has(resolved.activeProfile)) {
    throw new Error(`billing-attribution: unknown activeProfile ${resolved.activeProfile}`)
  }
  const env = { ...resolved, pricing }
  const searchStates = new Map(Object.entries(loadJsonObject(resolved.searchStatePath)))

  const persistSearchStates = () => {
    saveJsonObject(resolved.searchStatePath, Object.fromEntries(searchStates))
  }

  const ensureSearchState = (sessionId) => {
    const key = String(sessionId)
    let state = searchStates.get(key)
    if (state === undefined) {
      state = initHostSearchLedgerState()
      searchStates.set(key, state)
    }
    return state
  }

  const pollSearchState = (sessionId, at = Date.now()) => {
    if (!env.searchLedgerEnabled) return ensureSearchState(sessionId)
    const key = String(sessionId)
    let current = ensureSearchState(key)
    if (current.offset === 0
      && current.pending.length === 0
      && current.settlements.length === 0) {
      try {
        const existingBytes = statSync(env.searchLedgerPath).size
        if (existingBytes > 0) {
          current = { ...current, offset: existingBytes }
          searchStates.set(key, current)
          persistSearchStates()
        }
      } catch {
        // Missing ledger is a valid empty state.
      }
    }
    try {
      const billingState = readState(ctx, liveSession(key))
      const result = pollHostSearchLedger(current, {
        ledgerPath: env.searchLedgerPath,
        at,
        priceRecord: record => priceSearchLedgerRecord(pricing, record, {
          profile: billingState?.activeProfileOverride ?? resolved.activeProfile,
        }),
      })
      searchStates.set(key, result.state)
      persistSearchStates()
      return result.state
    } catch (error) {
      console.warn(
        `[${name}] search ledger unavailable: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      return current
    }
  }

  const liveSession = (sessionId) => {
    try {
      return ctx.get('sessions')?.list?.().find(item => String(item.id) === String(sessionId))
    } catch {
      return undefined
    }
  }

  const searchSummaryFor = (sessionId, turn, lastTurn) => {
    const state = ensureSearchState(sessionId)
    return {
      now: turnSearchSummary(state, turn),
      last: lastTurn === null ? null : turnSearchSummary(state, lastTurn),
    }
  }

  const viewOf = (state) => {
    const turn = state.currentTurn
    const lastTurn = state.lastTurn?.turn ?? null
    const searchState = pollSearchState(state.sessionId)
    const search = searchSummaryFor(state.sessionId, turn, lastTurn)
    const searchTurns = {}
    for (const turnKey of Object.keys(state.turns ?? {})) {
      searchTurns[turnKey] = turnSearchSummary(searchState, Number(turnKey))
    }
    if (turn !== null) {
      searchTurns[String(turn)] = turnSearchSummary(searchState, turn)
    }
    return billingView(state, env, search.now, search.last, searchTurns)
  }

  ctx.sessionProjections.register({
    key: BILLING_PROJECTION_KEY,
    stateVersion: BILLING_STATE_VERSION,
    stateSchema: billingStateSchema,
    init: header => ({
      ...initBillingState(header),
      activeProfileOverride: resolved.activeProfile,
    }),
    apply: (state, event) => applyBillingEvent(state, event, env),
    wire: {
      viewSchema: billingViewSchema,
      view: state => viewOf(state),
    },
  })

  ctx.commands.register({
    name: 'cost',
    description: '查看计费归因、价格档案和最近一次请求拆分',
    input: { hint: '[explain|profiles|profile auto|<id>]' },
    handler: (invocation) => {
      const parsed = parseCostCommand(invocation.rawInput, pricing)
      if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.message }
      const state = readState(ctx, invocation.agent.session)
      pollSearchState(state.sessionId)
      if (parsed.kind === 'profiles') {
        return {
          kind: 'success',
          text: renderProfiles(pricing, state.activeProfileOverride),
        }
      }
      if (parsed.kind === 'set-profile') {
        return {
          kind: 'success',
          text: `价格档案已切换为 ${parsed.profile}。从现在开始的请求按新档案归因；历史请求不重算。`,
        }
      }
      const view = viewOf(state)
      if (parsed.kind === 'explain') {
        return { kind: 'success', text: renderLastRequest(view) }
      }
      return { kind: 'success', text: renderBillingSummary(view, pricing) }
    },
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'web/deepseek-search-llm-request' && event.data?.body !== undefined) {
      try {
        const state = readState(ctx, session)
        const current = ensureSearchState(sessionId)
        searchStates.set(sessionId, observeSearchRequest(current, {
          body: event.data.body,
          sessionId,
          turn: state.currentTurn,
          step: state.currentStep,
          at: event.time,
        }))
        persistSearchStates()
      } catch (error) {
        warnOnce(`observe-search:${sessionId}`, error)
      }
    }

    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      try {
        const request = usageRecordFromEvent(session, event, env, readState(ctx, session))
        if (request !== null) appendUsageRecord(env.ledgerPath, request)
      } catch (error) {
        warnOnce(`usage-ledger:${sessionId}`, error)
      }
      pollSearchState(sessionId, event.time)
    }
    if (event.type === 'step/end' || event.type === 'turn/end') {
      pollSearchState(sessionId, event.time)
    }
  })

  console.log(
    `[${name}] active; currency=${pricing.displayCurrency}; `
    + `profiles=${pricing.profiles.size}; default=${pricing.defaultProfile}; `
    + `ledger=${env.ledgerPath}`,
  )

}

function usageRecordFromEvent(session, event, env, state) {
  const turn = numberOrNull(event.data?.turn)
  const step = numberOrNull(event.data?.step)
  if (turn === null || step === null) return null
  const usage = event.data?.usage ?? streamUsage(event.data?.stream)
  const source = event.data?.message?.source
  const route = source !== null && typeof source === 'object'
    ? { provider: source.provider, model: source.model }
    : state.route
  if (route === null || typeof route?.provider !== 'string' || typeof route?.model !== 'string') {
    return null
  }
  const requestKey = `${session.id}:${turn}:${step}`
  const priced = usage === undefined
    ? null
    : priceUsage(env.pricing, {
        provider: route.provider,
        model: route.model,
        usage,
        profile: state.activeProfileOverride,
        at: event.time,
        requestKind: 'model',
      })
  return {
    schema: 'dsh.billing.usage.v1',
    event: 'upsert',
    requestKey,
    sessionId: String(session.id),
    turn,
    step,
    observedAt: new Date(event.time ?? Date.now()).toISOString(),
    provider: route.provider,
    model: route.model,
    profileId: priced?.profileId ?? chooseProfileId(env.pricing, route.provider, state.activeProfileOverride),
    status: priced?.status ?? 'unknown',
    buckets: priced?.buckets ?? normalizeUsage(usage),
    components: priced?.components ?? [],
    unknownComponents: priced?.unknownComponents ?? ['usage'],
    listMicros: priced?.listMicros ?? 0,
    billedMicros: priced?.billedMicros ?? 0,
    accountMultiplier: priced?.accountMultiplier ?? null,
    pricingVerified: priced?.pricingVerified ?? false,
    peak: priced?.peak ?? null,
    origin: session.header?.origin ?? null,
    parentSessionId: session.header?.parentSession ?? null,
  }
}

function appendUsageRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

function readState(ctx, session) {
  if (session === undefined || session === null) return null
  try {
    const state = ctx.sessionProjections.stateOf(session, BILLING_PROJECTION_KEY)
    return state ?? null
  } catch {
    return null
  }
}

function loadJsonObject(path) {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  } catch (error) {
    console.warn(
      `[${name}] could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return {}
  }
}

function saveJsonObject(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    console.warn(
      `[${name}] could not persist ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  let usage
  for (const record of stream) {
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') {
      usage = record.chunk.usage
    } else if (record?.type === 'usage') {
      usage = record.usage
    }
  }
  return usage
}

function warnOnce(key, error) {
  const seen = warnOnce.seen ??= new Set()
  if (seen.has(key)) return
  seen.add(key)
  console.warn(
    `[${name}] ${key}: ${error instanceof Error ? error.message : String(error)}`,
  )
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function safeIntegerAtLeast(value, minimum, field) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`billing-attribution: ${field} must be a safe integer >= ${minimum}`)
  }
  return value
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}
