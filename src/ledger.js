import {
  ZERO_BUCKETS,
  addBuckets,
  chooseProfileId,
  formatMoney,
  hasAnyBuckets,
  normalizeUsage,
  priceUsage,
  subtractBuckets,
} from './pricing.js'
import {
  COST_SOURCE_PRIORITY,
  addCostSourceStats,
  addTextEvidence,
  contextEvidenceFromEvent,
  costSourceLabel,
  emptyCostSourceStats,
  emptyTextEvidence,
  estimateUsageForRequest,
  headerEvidenceFromEvent,
  mergeCostSourceStats,
  messageIdFromEvent,
  subtractCostSourceStats,
  summarizeCostSources,
} from './evidence.js'

export const BILLING_STATE_VERSION = 2
export const BILLING_PROJECTION_KEY = 'billing'

const EMPTY_COMPONENT_TOTALS = Object.freeze({
  uncachedInput: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  cacheRead: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  cacheWrite: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  output: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  searchFee: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  search: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  bill: Object.freeze({ listMicros: 0, billedMicros: 0 }),
  unknown: Object.freeze({ listMicros: 0, billedMicros: 0 }),
})

export function initBillingState(header = {}) {
  return {
    version: BILLING_STATE_VERSION,
    sessionId: typeof header.id === 'string' ? header.id : null,
    isSubagent: header.origin === 'subagent',
    parentSessionId: typeof header.parentSession === 'string' ? header.parentSession : null,
    activeProfileOverride: 'auto',
    route: null,
    currentTurn: null,
    currentStep: null,
    turnPhase: 'idle',
    inFlight: false,
    turnStartedAt: null,
    modelText: emptyTextEvidence(),
    requestHeaderText: emptyTextEvidence(),
    countedMessageIds: [],
    listSpentMicros: 0,
    billedSpentMicros: 0,
    unknownBuckets: { ...ZERO_BUCKETS },
    unknownComponents: [],
    componentTotals: cloneComponentTotals(EMPTY_COMPONENT_TOTALS),
    requestCount: 0,
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    searchRequestCount: 0,
    turnSearchRequestCount: 0,
    turnListSpentMicros: 0,
    turnBilledSpentMicros: 0,
    turnUnknownBuckets: { ...ZERO_BUCKETS },
    turnUnknownComponents: [],
    turnComponentTotals: cloneComponentTotals(EMPTY_COMPONENT_TOTALS),
    turnBuckets: { ...ZERO_BUCKETS },
    turnRoutes: [],
    turnCostSourceStats: emptyCostSourceStats(),
    turnRequestCount: 0,
    turnPricedRequestCount: 0,
    turnUnpricedRequestCount: 0,
    costSourceStats: emptyCostSourceStats(),
    turnCostSourceStats: emptyCostSourceStats(),
    lastRequest: null,
    lastTurn: null,
    turns: {},
    lastUsageAt: null,
    recentRequests: [],
  }
}

/**
 * Parse `/cost` without side effects.
 *
 * Supported:
 * - empty -> show
 * - explain -> show the last request
 * - profiles -> list profiles
 * - profile auto|<id> -> select a pricing profile
 */
export function parseCostCommand(rawInput, catalog) {
  const input = String(rawInput ?? '').trim()
  if (input === '') return { kind: 'show' }
  const lower = input.toLowerCase()
  if (lower === 'explain') return { kind: 'explain' }
  if (lower === 'profiles' || lower === 'profile') return { kind: 'profiles' }
  const match = /^profile\s+(\S+)$/iu.exec(input)
  if (match !== null) {
    const profile = match[1]
    if (profile !== 'auto' && !catalog.profiles.has(profile)) {
      return {
        kind: 'invalid',
        message: `未知价格档案：${profile}。可用：${[...catalog.profiles.keys()].join(', ')}`,
      }
    }
    return { kind: 'set-profile', profile }
  }
  return {
    kind: 'invalid',
    message: '用法：/cost、/cost explain、/cost profiles、/cost profile auto|<档案名>',
  }
}

export function applyBillingEvent(state, event, env) {
  switch (event.type) {
    case 'command/run':
      return applyCommandEvent(state, event, env)
    case 'turn/start':
      return startTurn(state, event)
    case 'request/header':
      return updateRequestHeader(state, event)
    case 'request/context':
      return state.route === null ? updateRoute(state, routeFromContext(event)) : state
    case 'system/message':
    case 'user/message':
    case 'tool/message':
      return addContextMessage(state, event)
    case 'step/start': {
      const turn = numberOrNull(event.data?.turn)
      const step = numberOrNull(event.data?.step)
      if (turn === null || step === null) return state
      if (state.inFlight && state.currentTurn === turn && state.currentStep === step) return state
      return {
        ...state,
        inFlight: true,
        currentTurn: turn,
        currentStep: step,
      }
    }
    case 'assistant/message':
    case 'assistant/attempt':
      return applyUsageEvent(state, event, env)
    case 'assistant/chunk':
      return event.data?.chunk?.type === 'usage'
        ? applyUsageEvent(state, event, env)
        : finishFlight(state)
    case 'web/deepseek-search-llm-request':
      return {
        ...state,
        searchRequestCount: state.searchRequestCount + 1,
        turnSearchRequestCount: state.turnSearchRequestCount + 1,
      }
    case 'step/end':
      return finishFlight(state)
    case 'turn/end':
      return endTurn(finishFlight(state), event)
    default:
      return state
  }
}

export function billingView(state, env, searchNow = null, searchLast = null, searchTurns = null) {
  const turn = state.currentTurn
  const phase = state.turnPhase ?? 'idle'
  const currentSearch = phase === 'active'
    ? searchNow
    : phase === 'ended'
      ? searchLast ?? searchNow
      : null
  const lastSearch = state.lastTurn === null ? null : searchLast ?? searchNow
  const listSpentMicros = state.listSpentMicros + (searchNow?.totalListMicros ?? 0)
  const billedSpentMicros = state.billedSpentMicros + (searchNow?.totalBilledMicros ?? 0)
  const baseTurnListMicros = phase === 'ended'
    ? state.lastTurn?.listMicros ?? state.turnListSpentMicros
    : state.turnListSpentMicros
  const baseTurnBilledMicros = phase === 'ended'
    ? state.lastTurn?.billedMicros ?? state.turnBilledSpentMicros
    : state.turnBilledSpentMicros
  const turnListMicros = baseTurnListMicros + (currentSearch?.listMicros ?? 0)
  const turnBilledMicros = baseTurnBilledMicros + (currentSearch?.billedMicros ?? 0)
  const turnComponentTotals = mergeComponentTotals(
    phase === 'ended' ? state.lastTurn?.componentTotals ?? EMPTY_COMPONENT_TOTALS : state.turnComponentTotals,
    currentSearch?.componentTotals ?? {},
  )
  const componentTotals = mergeComponentTotals(
    state.componentTotals,
    aggregateSearchComponentTotals(searchNow),
  )
  const lastTurn = state.lastTurn === null
    ? null
    : {
        ...state.lastTurn,
        listMicros: state.lastTurn.listMicros + (lastSearch?.listMicros ?? 0),
        billedMicros: state.lastTurn.billedMicros + (lastSearch?.billedMicros ?? 0),
        searchListMicros: lastSearch?.listMicros ?? 0,
        searchBilledMicros: lastSearch?.billedMicros ?? 0,
        searchRequestCount: lastSearch?.settledRequestCount ?? 0,
        unknown: state.lastTurn.unknown || (lastSearch?.turnUnknownSettlements ?? 0) > 0,
      }
  const unknown = state.unpricedRequestCount > 0
    || hasAnyBuckets(state.unknownBuckets)
    || state.unknownComponents.length > 0
    || (searchNow?.unknownSettlements ?? 0) > 0
  const route = state.route
  const turnCosts = buildTurnCosts(state, searchTurns)
  const turnUnknown = turn === null
    ? false
    : turnCosts[String(turn)]?.unknown === true
  let profileId = null
  let profile = null
  try {
    profileId = chooseProfileId(env.pricing, route?.provider, state.activeProfileOverride)
    profile = env.pricing.profiles.get(profileId)
  } catch {
    // A stale profile override must be visible, not crash the projection.
  }
  return {
    schemaVersion: 1,
    currency: env.displayCurrency,
    phase,
    currentTurn: turn,
    currentStep: state.currentStep,
    inFlight: state.inFlight,
    turnPhase: phase,
    route,
    profileId,
    profileLabel: profile?.label ?? null,
    billingBasis: profile?.billingBasis ?? null,
    accountMultiplier: profile?.accountMultiplier ?? null,
    listSpentMicros,
    billedSpentMicros,
    turnListMicros,
    turnBilledMicros,
    turnUnknown,
    costSourceStats: state.costSourceStats ?? emptyCostSourceStats(),
    turnCostSourceStats: turnCosts[String(turn)]?.costSourceStats
      ?? state.turnCostSourceStats
      ?? emptyCostSourceStats(),
    turnRequestCount: state.turnRequestCount + (currentSearch?.settledRequestCount ?? 0),
    requestCount: state.requestCount + (searchNow?.settledRequestCount ?? 0),
    pricedRequestCount: state.pricedRequestCount,
    unpricedRequestCount: state.unpricedRequestCount,
    searchRequestCount: state.searchRequestCount,
    turnSearchRequestCount: state.turnSearchRequestCount,
    lastRequest: state.lastRequest,
    lastTurn,
    componentTotals,
    turnComponentTotals,
    turnCosts,
    unknownBuckets: state.unknownBuckets,
    unknownComponents: state.unknownComponents,
    unknown,
    isSubagent: state.isSubagent,
    parentSessionId: state.parentSessionId,
    pricingVersion: env.pricing.version,
    pricingVerified: profile?.verified === true,
    tailRisk: false,
  }
}

export function renderBillingSummary(view, catalog) {
  const lines = [
    `计费统计 · ${view.phase === 'active' ? '本轮进行中' : view.phase === 'ended' ? '上一轮已结束' : '等待请求'}`,
    `${view.turnPhase === 'ended' ? '上一轮' : '本轮'}：账单口径 ${formatCost(view.turnBilledMicros, view.turnUnknown, view.currency)}；公开价 ${formatCost(view.turnListMicros, view.turnUnknown, view.currency)}；请求 ${view.turnRequestCount} 次`,
    `会话累计：账单口径 ${formatCost(view.billedSpentMicros, view.unknown, view.currency)}；公开价 ${formatCost(view.listSpentMicros, view.unknown, view.currency)}`,
  ]
  const turnSources = formatSourceSummary(view.turnCostSourceStats, view.currency)
  if (turnSources !== '') lines.push(`本轮费用来源：${turnSources}`)
  const sessionSources = formatSourceSummary(view.costSourceStats, view.currency)
  if (sessionSources !== '') lines.push(`会话费用来源：${sessionSources}`)
  if (view.route !== null) {
    lines.push(
      `当前路由：${view.route.provider}/${view.route.model}；价格档案：${view.profileLabel ?? view.profileId ?? '未知'}`,
    )
  }
  if (view.searchRequestCount > 0) {
    lines.push(`搜索请求：${view.searchRequestCount} 次；工具搜索费用已单独列入搜索分项。`)
  }
  const parts = formatComponents(view.turnComponentTotals, view.currency)
  if (parts.length > 0) lines.push(`本轮分项：${parts.join('；')}`)
  if (view.lastRequest !== null) {
    const lastUnknown = isUnknownRequest(view.lastRequest)
    lines.push(
      `最近一次：${view.lastRequest.provider}/${view.lastRequest.model}，`
      + `账单口径 ${formatCost(view.lastRequest.billedMicros, lastUnknown, view.currency)}，`
      + `公开价 ${formatCost(view.lastRequest.listMicros, lastUnknown, view.currency)}`,
    )
  }
  if (view.unknown) {
    lines.push('未知项：存在缺 usage 或缺价格的分项，未知 token 没有按 0 计算。')
  }
  const profile = view.profileId === null ? undefined : catalog.profiles.get(view.profileId)
  if (profile?.accountMultiplierSource) {
    lines.push(`账户倍率：×${profile.accountMultiplier}；${profile.accountMultiplierSource}`)
  }
  lines.push(`价格档案版本：${view.pricingVersion}；汇率：1 USD = ${catalog.usdToCny} ${view.currency}`)
  return lines.join('\n')
}

export function renderLastRequest(view) {
  if (view.lastRequest === null) return '还没有可解释的请求记录。'
  const request = view.lastRequest
  const unknown = isUnknownRequest(request)
  const usageUnknown = request.unknownComponents.includes('usage')
    || request.costSource === 'unknown'
  const lines = [
    `最近一次请求：${request.provider}/${request.model}`,
    `请求类型：${request.requestKind}；状态：${request.status}；时间：${request.at ?? '未知'}`,
    `费用来源：${sourceDescription(request.costSource)}`,
    `账单口径：${formatCost(request.billedMicros, unknown, view.currency)}；公开价：${formatCost(request.listMicros, unknown, view.currency)}`,
    usageUnknown
      ? 'tokens：未知（提供商未返回 usage；主动中止或断流时可能发生）'
      : `tokens：未缓存输入 ${request.buckets.uncachedInputTokens}；缓存读取 ${request.buckets.cacheReadTokens}；缓存写入 ${request.buckets.cacheWriteTokens}；输出 ${request.buckets.outputTokens}`,
  ]
  for (const component of request.components) {
    if (component.kind === 'fixed-search-fee') {
      lines.push(
        `分项：搜索固定费 ${component.searchRequests} 次，公开价 ${formatMoney(component.listMicros, view.currency)}，账单口径 ${formatMoney(component.billedMicros, view.currency)}`,
      )
    } else {
      lines.push(
        `分项：${bucketLabel(component.bucket)} ${component.tokens} tokens × ${component.ratePer1M} ${component.rateCurrency}/M`
        + `${component.peakMultiplier > 1 ? `（峰时 ×${component.peakMultiplier}）` : ''}`
        + ` = 公开价 ${formatMoney(component.listMicros, view.currency)}，账单口径 ${formatMoney(component.billedMicros, view.currency)}`,
      )
    }
  }
  if (request.unknownComponents.length > 0) {
    lines.push(`未知分项：${request.unknownComponents.map(unknownComponentLabel).join('; ')}`)
  }
  return lines.join('\n')
}

export function renderProfiles(catalog, activeProfile = 'auto') {
  const lines = [`当前选择：${activeProfile}`, '可用价格档案：']
  for (const profile of catalog.profiles.values()) {
    lines.push(
      `- ${profile.id}：${profile.label}；${profile.billingBasis}；`
      + `账户倍率 ×${profile.accountMultiplier}；模型 ${profile.modelCount ?? new Set(profile.models.values()).size} 个；`
      + `${profile.verified ? '已验证' : '待验证'}`,
    )
  }
  return lines.join('\n')
}

export const billingStateSchema = {
  parse(value) {
    assertBillingState(value)
    return value
  },
}

export const billingViewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('billing view must be an object')
    }
    if (typeof value.phase !== 'string' || typeof value.currency !== 'string') {
      throw new TypeError('billing view lacks phase/currency')
    }
    return value
  },
}

function applyCommandEvent(state, event, env) {
  if (event.data?.name !== 'cost') return state
  const parsed = parseCostCommand(event.data.args ?? '', env.pricing)
  if (parsed.kind !== 'set-profile') return state
  return { ...state, activeProfileOverride: parsed.profile }
}

function startTurn(state, event) {
  const turn = numberOrNull(event.data?.turn)
  if (turn === null) return state
  return {
    ...state,
    inFlight: false,
    currentTurn: turn,
    currentStep: null,
    turnPhase: 'active',
    turnStartedAt: event.time,
    turnListSpentMicros: 0,
    turnBilledSpentMicros: 0,
    turnUnknownBuckets: { ...ZERO_BUCKETS },
    turnUnknownComponents: [],
    turnComponentTotals: cloneComponentTotals(EMPTY_COMPONENT_TOTALS),
    turnBuckets: { ...ZERO_BUCKETS },
    turnRoutes: [],
    turnRequestCount: 0,
    turnPricedRequestCount: 0,
    turnUnpricedRequestCount: 0,
    turnSearchRequestCount: 0,
    lastRequest: null,
  }
}

function endTurn(state, event) {
  const turn = numberOrNull(event.data?.turn) ?? state.currentTurn
  const lastTurn = {
    turn,
    listMicros: state.turnListSpentMicros,
    billedMicros: state.turnBilledSpentMicros,
    requestCount: state.turnRequestCount,
    pricedRequestCount: state.turnPricedRequestCount,
    unpricedRequestCount: state.turnUnpricedRequestCount,
    unknownBuckets: state.turnUnknownBuckets,
    unknownComponents: state.turnUnknownComponents,
    componentTotals: state.turnComponentTotals,
    buckets: state.turnBuckets,
    routes: state.turnRoutes,
    costSourceStats: state.turnCostSourceStats ?? emptyCostSourceStats(),
    unknown: state.turnUnpricedRequestCount > 0
      || hasAnyBuckets(state.turnUnknownBuckets)
      || state.turnUnknownComponents.length > 0,
    searchRequestCount: state.turnSearchRequestCount,
    startedAt: state.turnStartedAt,
    endedAt: event.time,
  }
  return {
    ...state,
    inFlight: false,
    turnPhase: 'ended',
    lastTurn,
    turns: {
      ...(state.turns ?? {}),
      [String(turn)]: lastTurn,
    },
  }
}

function buildRequest({
  state,
  event,
  env,
  requestKey,
  turn,
  step,
  officialUsage,
  estimated,
  billDetail,
}) {
  const route = routeFromMessage(event) ?? state.route
  const provider = route?.provider ?? 'unknown'
  const model = route?.model ?? 'unknown'
  const base = {
    requestKey,
    sessionId: state.sessionId,
    turn,
    step,
    provider,
    model,
    requestKind: 'model',
    at: event.time,
  }
  if (billDetail !== null) {
    const priced = priceRequest(env, {
      state,
      event,
      provider,
      model,
      usage: officialUsage ?? estimated.usage,
    })
    const billBuckets = bucketsFromBill(billDetail) ?? estimated.usage
    return {
      ...base,
      ...withoutProfile(priced),
      status: 'priced',
      costSource: 'bill',
      buckets: billBuckets,
      components: [{
        kind: 'bill-total',
        category: 'bill',
        listMicros: priced.listMicros,
        billedMicros: billDetail.amountMicros,
      }],
      unknownComponents: [],
      listMicros: priced.listMicros,
      billedMicros: billDetail.amountMicros,
      billDetail: {
        sourceRow: billDetail.sourceRow ?? null,
        requestId: billDetail.requestId ?? null,
        requestKey: billDetail.requestKey ?? requestKey,
      },
      estimate: officialUsage === undefined ? estimated.evidence : null,
    }
  }
  if (officialUsage !== undefined) {
    const priced = priceRequest(env, {
      state,
      event,
      provider,
      model,
      usage: officialUsage,
    })
    return {
      ...base,
      ...withoutProfile(priced),
      costSource: priced.status === 'unknown' ? 'unknown' : 'usage',
      estimate: null,
    }
  }
  const priced = priceRequest(env, {
    state,
    event,
    provider,
    model,
    usage: estimated.usage,
  })
  const estimatedEmpty = estimated.usage.uncachedInputTokens === 0
    && estimated.usage.outputTokens === 0
  return {
    ...base,
    ...withoutProfile(priced),
    costSource: priced.status === 'unknown' || estimatedEmpty ? 'unknown' : 'estimate',
    status: priced.status === 'unknown' || estimatedEmpty
      ? 'unknown'
      : priced.status === 'priced'
        ? 'estimated'
        : priced.status,
    unknownComponents: priced.status === 'unknown' || estimatedEmpty
      ? appendUnique(priced.unknownComponents, ['estimate'])
      : priced.unknownComponents,
    estimate: estimated.evidence,
  }
}

function priceRequest(env, { state, event, provider, model, usage }) {
  return priceUsage(env.pricing, {
    provider,
    model,
    usage,
    profile: state.activeProfileOverride,
    at: event.time,
    requestKind: 'model',
  })
}

function withoutProfile(priced) {
  const { profile, ...fields } = priced
  return fields
}

function bucketsFromBill(record) {
  const buckets = {
    uncachedInputTokens: record?.inputTokens ?? 0,
    cacheReadTokens: record?.cacheReadTokens ?? 0,
    cacheWriteTokens: record?.cacheWriteTokens ?? 0,
    outputTokens: record?.outputTokens ?? 0,
  }
  return hasAnyBuckets(buckets) ? buckets : null
}

function resolveBillDetail(env, sessionId, turn, step) {
  if (!(env?.billDetails instanceof Map)) return null
  return env.billDetails.get(`${sessionId}:${turn}:${step}`) ?? null
}

function sourcePriority(source) {
  return COST_SOURCE_PRIORITY[source] ?? COST_SOURCE_PRIORITY.unknown
}

function applyUsageEvent(state, event, env) {
  const turn = numberOrNull(event.data?.turn)
  const step = numberOrNull(event.data?.step)
  if (turn === null || step === null) return state
  const requestKey = `${turn}:${step}`
  const previous = state.recentRequests.find(item => item.requestKey === requestKey) ?? null
  const officialUsage = usageFromEvent(event)
  const estimated = estimateUsageForRequest(state, event)
  const billDetail = resolveBillDetail(env, state.sessionId, turn, step)
  const request = buildRequest({
    state,
    event,
    env,
    requestKey,
    turn,
    step,
    officialUsage,
    estimated,
    billDetail,
  })
  if (previous !== null
    && sourcePriority(previous.costSource) > sourcePriority(request.costSource)) {
    return addContextMessage(state, event)
  }
  let next = previous === null ? state : removeRequest(state, previous)
  const route = routeFromMessage(event) ?? next.route
  const provider = route?.provider ?? 'unknown'
  const model = route?.model ?? 'unknown'
  const unknown = isUnknownRequest(request)
  const routeKey = provider === 'unknown' || model === 'unknown'
    ? null
    : `${provider}/${model}`
  const componentTotals = addComponents(next.componentTotals, request.components, unknown)
  const turnComponentTotals = addComponents(next.turnComponentTotals, request.components, unknown)
  const recentRequests = [...next.recentRequests, request]
    .slice(-Math.max(1, env.maxRecentRequests))
  return {
    ...next,
    inFlight: false,
    lastUsageAt: event.time,
    lastRequest: request,
    recentRequests,
    requestCount: next.requestCount + 1,
    pricedRequestCount: next.pricedRequestCount + (unknown ? 0 : 1),
    unpricedRequestCount: next.unpricedRequestCount + (unknown ? 1 : 0),
    listSpentMicros: next.listSpentMicros + request.listMicros,
    billedSpentMicros: next.billedSpentMicros + request.billedMicros,
    unknownBuckets: addBuckets(next.unknownBuckets, unknownBucketsOf(request)),
    unknownComponents: appendUnique(next.unknownComponents, request.unknownComponents),
    componentTotals,
    turnListSpentMicros: next.turnListSpentMicros + request.listMicros,
    turnBilledSpentMicros: next.turnBilledSpentMicros + request.billedMicros,
    turnUnknownBuckets: addBuckets(next.turnUnknownBuckets, unknownBucketsOf(request)),
    turnUnknownComponents: appendUnique(next.turnUnknownComponents, request.unknownComponents),
    turnComponentTotals,
    turnBuckets: addBuckets(next.turnBuckets, request.buckets),
    turnRoutes: routeKey === null
      ? next.turnRoutes
      : appendUnique(next.turnRoutes, [routeKey]),
    turnRequestCount: next.turnRequestCount + 1,
    turnPricedRequestCount: next.turnPricedRequestCount + (unknown ? 0 : 1),
    turnUnpricedRequestCount: next.turnUnpricedRequestCount + (unknown ? 1 : 0),
    costSourceStats: addCostSourceStats(next.costSourceStats, request.costSource, request),
    turnCostSourceStats: addCostSourceStats(
      next.turnCostSourceStats,
      request.costSource,
      request,
    ),
  }
  return addContextMessage(withRequest, event)
}

function removeRequest(state, request) {
  const unknown = isUnknownRequest(request)
  return {
    ...state,
    recentRequests: state.recentRequests.filter(item => item.requestKey !== request.requestKey),
    requestCount: Math.max(0, state.requestCount - 1),
    pricedRequestCount: Math.max(0, state.pricedRequestCount - (unknown ? 0 : 1)),
    unpricedRequestCount: Math.max(0, state.unpricedRequestCount - (unknown ? 1 : 0)),
    listSpentMicros: Math.max(0, state.listSpentMicros - request.listMicros),
    billedSpentMicros: Math.max(0, state.billedSpentMicros - request.billedMicros),
    unknownBuckets: subtractBuckets(state.unknownBuckets, unknownBucketsOf(request)),
    componentTotals: removeComponents(state.componentTotals, request.components),
    turnListSpentMicros: Math.max(0, state.turnListSpentMicros - request.listMicros),
    turnBilledSpentMicros: Math.max(0, state.turnBilledSpentMicros - request.billedMicros),
    turnUnknownBuckets: subtractBuckets(state.turnUnknownBuckets, unknownBucketsOf(request)),
    turnComponentTotals: removeComponents(state.turnComponentTotals, request.components),
    turnBuckets: subtractBuckets(state.turnBuckets, request.buckets),
    turnRequestCount: Math.max(0, state.turnRequestCount - 1),
    turnPricedRequestCount: Math.max(0, state.turnPricedRequestCount - (unknown ? 0 : 1)),
    turnUnpricedRequestCount: Math.max(0, state.turnUnpricedRequestCount - (unknown ? 1 : 0)),
    costSourceStats: subtractCostSourceStats(
      state.costSourceStats,
      request.costSource,
      request,
    ),
    turnCostSourceStats: subtractCostSourceStats(
      state.turnCostSourceStats,
      request.costSource,
      request,
    ),
  }
}

function isUnknownRequest(request) {
  return request.status === 'unknown' || request.unknownComponents.length > 0
}

function addComponents(target, components, unknown) {
  const next = cloneComponentTotals(target)
  for (const component of components) {
    const key = componentKey(component)
    const current = next[key] ?? { listMicros: 0, billedMicros: 0 }
    next[key] = {
      listMicros: current.listMicros + (component.listMicros ?? 0),
      billedMicros: current.billedMicros + (component.billedMicros ?? 0),
    }
  }
  if (unknown) {
    const current = next.unknown ?? { listMicros: 0, billedMicros: 0 }
    next.unknown = { ...current }
  }
  return next
}

function removeComponents(target, components) {
  const next = cloneComponentTotals(target)
  for (const component of components) {
    const key = componentKey(component)
    if (next[key] === undefined) continue
    next[key] = {
      listMicros: Math.max(0, next[key].listMicros - (component.listMicros ?? 0)),
      billedMicros: Math.max(0, next[key].billedMicros - (component.billedMicros ?? 0)),
    }
  }
  return next
}

function componentKey(component) {
  if (component.kind === 'fixed-search-fee') return 'searchFee'
  if (component.kind === 'bill-total') return 'bill'
  if (component.category === 'search-token') return bucketKey(component.bucket)
  if (component.category === 'search') return 'search'
  return bucketKey(component.bucket)
}

function bucketKey(bucket) {
  return {
    uncachedInputTokens: 'uncachedInput',
    cacheReadTokens: 'cacheRead',
    cacheWriteTokens: 'cacheWrite',
    outputTokens: 'output',
  }[bucket] ?? 'unknown'
}

function unknownBucketsOf(request) {
  if (request.unknownComponents.includes('usage')) return { ...request.buckets }
  const result = { ...ZERO_BUCKETS }
  for (const component of request.unknownComponents) {
    if (component.includes('uncachedInputTokens')) result.uncachedInputTokens = request.buckets.uncachedInputTokens
    if (component.includes('cacheReadTokens')) result.cacheReadTokens = request.buckets.cacheReadTokens
    if (component.includes('cacheWriteTokens')) result.cacheWriteTokens = request.buckets.cacheWriteTokens
    if (component.includes('outputTokens')) result.outputTokens = request.buckets.outputTokens
  }
  return result
}

function mergeComponentTotals(left, right) {
  const next = cloneComponentTotals(left)
  for (const [key, value] of Object.entries(right ?? {})) {
    const current = next[key] ?? { listMicros: 0, billedMicros: 0 }
    next[key] = {
      listMicros: current.listMicros + (value.listMicros ?? 0),
      billedMicros: current.billedMicros + (value.billedMicros ?? 0),
    }
  }
  return next
}

function buildTurnCosts(state, searchTurns) {
  const costs = {}
  for (const [key, base] of Object.entries(state.turns ?? {})) {
    costs[key] = mergeTurnCost(base, searchTurns?.[key] ?? null)
  }
  if (state.currentTurn !== null && (state.turnPhase === 'active' || costs[String(state.currentTurn)] === undefined)) {
    const key = String(state.currentTurn)
    costs[key] = mergeTurnCost({
      turn: state.currentTurn,
      listMicros: state.turnListSpentMicros,
      billedMicros: state.turnBilledSpentMicros,
      requestCount: state.turnRequestCount,
      componentTotals: state.turnComponentTotals,
      buckets: state.turnBuckets,
      routes: state.turnRoutes,
      unknownComponents: state.turnUnknownComponents,
      costSourceStats: state.turnCostSourceStats ?? emptyCostSourceStats(),
      unknown: state.turnUnpricedRequestCount > 0
        || hasAnyBuckets(state.turnUnknownBuckets)
        || state.turnUnknownComponents.length > 0,
    }, searchTurns?.[key] ?? null)
  }
  return costs
}

function mergeTurnCost(base, search) {
  const mainComponentTotals = cloneComponentTotals(base.componentTotals ?? EMPTY_COMPONENT_TOTALS)
  const searchComponentTotals = cloneComponentTotals(search?.componentTotals ?? {})
  const searchBilledMicros = search?.billedMicros ?? 0
  const searchListMicros = search?.listMicros ?? 0
  const searchRequestCount = search?.settledRequestCount ?? 0
  return {
    turn: base.turn,
    listMicros: base.listMicros + searchListMicros,
    billedMicros: base.billedMicros + searchBilledMicros,
    mainListMicros: base.listMicros,
    mainBilledMicros: base.billedMicros,
    searchListMicros,
    searchBilledMicros,
    requestCount: base.requestCount + searchRequestCount,
    searchRequestCount,
    mainComponentTotals,
    searchComponentTotals,
    componentTotals: mergeComponentTotals(mainComponentTotals, searchComponentTotals),
    buckets: { ...ZERO_BUCKETS, ...(base.buckets ?? {}) },
    routes: Array.isArray(base.routes) ? base.routes : [],
    unknownComponents: Array.isArray(base.unknownComponents) ? base.unknownComponents : [],
    costSourceStats: mergeCostSourceStats(
      base.costSourceStats,
      search?.costSourceStats,
    ),
    unknown: base.unknown === true || (search?.unknownSettlements ?? 0) > 0,
  }
}

function formatCost(micros, unknown, currency) {
  if (unknown !== true) return formatMoney(micros, currency)
  return micros > 0 ? formatMoney(micros, currency) : '未知'
}

function unknownComponentLabel(value) {
  if (value === 'usage') return 'token 用量（usage）'
  if (value === 'estimate') return '可用于文本估算的内容'
  return value
}

function formatSourceSummary(stats, currency) {
  return summarizeCostSources(stats)
    .map(item => item.source === 'unknown'
      ? `${item.label} ${item.requestCount} 次`
      : `${item.label} ${formatMoney(item.billedMicros, currency)}`)
    .join('；')
}

function sourceDescription(source) {
  if (source === 'estimate') {
    return '文本估算（按可见字符数折算 token，不是官方 token 用量）'
  }
  return costSourceLabel(source)
}

function aggregateSearchComponentTotals(summary) {
  return summary?.componentTotals ?? {}
}

function cloneComponentTotals(source) {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, { ...value }]),
  )
}

function formatComponents(totals, currency) {
  return Object.entries(totals)
    .filter(([, value]) => value.listMicros > 0 || value.billedMicros > 0)
    .map(([key, value]) => `${componentLabel(key)} ${formatMoney(value.billedMicros, currency)}`)
}

function componentLabel(key) {
  return {
    uncachedInput: '未缓存输入',
    uncachedInputTokens: '未缓存输入',
    cacheRead: '缓存读取',
    cacheReadTokens: '缓存读取',
    cacheWrite: '缓存写入',
    cacheWriteTokens: '缓存写入',
    output: '输出（含 reasoning）',
    outputTokens: '输出（含 reasoning）',
    searchFee: '搜索固定费',
    search: '搜索',
    bill: '账单合计',
    unknown: '未知',
  }[key] ?? key
}

function bucketLabel(bucket) {
  return componentLabel({
    uncachedInputTokens: 'uncachedInput',
    cacheReadTokens: 'cacheRead',
    cacheWriteTokens: 'cacheWrite',
    outputTokens: 'output',
  }[bucket] ?? bucket)
}

function appendUnique(list, values) {
  return [...new Set([...list, ...values])]
}

function updateRoute(state, route) {
  if (route === null) return state
  if (state.route?.provider === route.provider
    && state.route?.model === route.model
    && state.route?.maxTokens === route.maxTokens) {
    return state
  }
  return { ...state, route }
}

function updateRequestHeader(state, event) {
  const route = routeFromHeader(event)
  const next = route === null ? state : updateRoute(state, route)
  return {
    ...next,
    requestHeaderText: headerEvidenceFromEvent(event),
  }
}

function addContextMessage(state, event) {
  const messageId = messageIdFromEvent(event)
  const countedMessageIds = state.countedMessageIds ?? []
  if (messageId !== null && countedMessageIds.includes(messageId)) return state
  const evidence = contextEvidenceFromEvent(event)
  if (evidence.cjkChars === 0 && evidence.otherChars === 0) {
    return messageId === null
      ? state
      : {
          ...state,
          countedMessageIds: [...countedMessageIds, messageId].slice(-512),
        }
  }
  return {
    ...state,
    modelText: addTextEvidence(state.modelText, evidence),
    countedMessageIds: messageId === null
      ? countedMessageIds
      : [...countedMessageIds, messageId].slice(-512),
  }
}

function routeFromHeader(event) {
  const config = event.data?.header?.config
  if (!isObject(config)) return null
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
  return {
    provider: config.provider,
    model: config.model,
    maxTokens: numberOrNull(config.maxTokens),
  }
}

function routeFromContext(event) {
  const provider = event.data?.provider
  const model = event.data?.model
  return typeof provider === 'string' && typeof model === 'string'
    ? { provider, model, maxTokens: null }
    : null
}

function routeFromMessage(event) {
  const source = event.data?.message?.source
  if (!isObject(source)) return null
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') return null
  return { provider: source.provider, model: source.model, maxTokens: null }
}

function usageFromEvent(event) {
  if (event.type === 'assistant/chunk') {
    return event.data?.chunk?.type === 'usage' ? event.data.chunk.usage : undefined
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') {
    return undefined
  }
  return event.data?.usage ?? streamUsage(event.data?.stream)
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

function finishFlight(state) {
  return state.inFlight ? { ...state, inFlight: false } : state
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertBillingState(value) {
  if (!isObject(value)) throw new TypeError('billing state must be an object')
  if (value.version !== BILLING_STATE_VERSION) {
    throw new TypeError(`billing state version must be ${BILLING_STATE_VERSION}`)
  }
  if (typeof value.activeProfileOverride !== 'string') {
    throw new TypeError('billing state activeProfileOverride is invalid')
  }
  for (const field of [
    'listSpentMicros',
    'billedSpentMicros',
    'turnListSpentMicros',
    'turnBilledSpentMicros',
    'requestCount',
    'pricedRequestCount',
    'unpricedRequestCount',
    'searchRequestCount',
    'turnSearchRequestCount',
    'turnRequestCount',
    'turnPricedRequestCount',
    'turnUnpricedRequestCount',
  ]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new TypeError(`billing state ${field} is invalid`)
    }
  }
  for (const bucket of Object.keys(ZERO_BUCKETS)) {
    if (!Number.isSafeInteger(value.unknownBuckets?.[bucket]) || value.unknownBuckets[bucket] < 0) {
      throw new TypeError(`billing state unknown bucket ${bucket} is invalid`)
    }
    if (!Number.isSafeInteger(value.turnUnknownBuckets?.[bucket])
      || value.turnUnknownBuckets[bucket] < 0) {
      throw new TypeError(`billing state turnUnknown bucket ${bucket} is invalid`)
    }
    if (!Number.isSafeInteger(value.turnBuckets?.[bucket]) || value.turnBuckets[bucket] < 0) {
      throw new TypeError(`billing state turn bucket ${bucket} is invalid`)
    }
  }
  if (value.turns === null || typeof value.turns !== 'object' || Array.isArray(value.turns)) {
    throw new TypeError('billing state turns is invalid')
  }
}
