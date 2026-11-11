/**
 * Host-side search ledger fold.
 *
 * It correlates DSH's pre-dispatch search request with the immutable shim
 * ledger. Pricing is delegated to the current catalog at settlement time so a
 * fitted profile is reflected without changing the shim.
 */

import {
  fingerprintSearchRequest,
  readSearchLedgerSince,
} from './search-ledger.js'

export const HOST_SEARCH_LEDGER_STATE_VERSION = 2
export const DEFAULT_MAX_PENDING_AGE_MS = 10 * 60 * 1000
export const DEFAULT_MAX_RECENT_IDS = 4096

export function initHostSearchLedgerState() {
  return {
    version: HOST_SEARCH_LEDGER_STATE_VERSION,
    offset: 0,
    pending: [],
    settlements: [],
    recentLedgerIds: [],
    listSpentMicros: 0,
    billedSpentMicros: 0,
    turnListSpentMicros: {},
    turnBilledSpentMicros: {},
    turnUnknownSettlements: {},
    requestCount: 0,
    unknownSettlements: 0,
  }
}

export function observeSearchRequest(state, {
  body,
  sessionId,
  turn,
  step,
  requestId = null,
  at = Date.now(),
}) {
  const nextSequence = state.pending.length === 0
    ? 1
    : Math.max(...state.pending.map(item => item.sequence)) + 1
  return {
    ...state,
    pending: [
      ...state.pending,
      {
        sequence: nextSequence,
        fingerprint: fingerprintSearchRequest(body),
        sessionId,
        turn,
        step,
        requestId,
        createdAt: epochMs(at),
      },
    ],
    requestCount: (state.requestCount ?? 0) + 1,
  }
}

/**
 * @param {object} state
 * @param {{ledgerPath: string, at?: number|string|Date, limit?: number,
 *   maxPendingAgeMs?: number, maxRecentIds?: number,
 *   priceRecord: (record: object) => {listMicros:number, billedMicros:number,
 *     status:string, components:object[], unknownComponents:string[]}}} options
 */
export function pollHostSearchLedger(state, {
  ledgerPath,
  at = Date.now(),
  limit = 1000,
  maxPendingAgeMs = DEFAULT_MAX_PENDING_AGE_MS,
  maxRecentIds = DEFAULT_MAX_RECENT_IDS,
  priceRecord,
}) {
  if (typeof priceRecord !== 'function') {
    throw new TypeError('pollHostSearchLedger requires priceRecord(record)')
  }
  const page = readSearchLedgerSince(ledgerPath, state.offset, { limit })
  let next = {
    ...state,
    offset: page.nextOffset,
    turnListSpentMicros: { ...state.turnListSpentMicros },
    turnBilledSpentMicros: { ...state.turnBilledSpentMicros },
    turnUnknownSettlements: { ...state.turnUnknownSettlements },
  }

  for (const record of page.records) {
    if (next.recentLedgerIds.includes(record.ledgerId)) continue
    const index = findMatch(next.pending, record)
    next = rememberLedgerId(next, record.ledgerId, maxRecentIds)
    const priced = priceRecord(record)
    if (index < 0) {
      next = {
        ...next,
        settlements: pushCapped(next.settlements, {
          ledgerId: record.ledgerId,
          status: 'unmatched',
          listMicros: priced.listMicros,
          billedMicros: priced.billedMicros,
          costStatus: priced.status,
          turn: null,
          step: null,
        }, maxRecentIds),
      }
      continue
    }

    const expectation = next.pending[index]
    const turnKey = String(expectation.turn)
    const unknown = priced.status === 'unknown' || priced.unknownComponents.length > 0
    next = {
      ...next,
      pending: next.pending.filter((_, itemIndex) => itemIndex !== index),
      listSpentMicros: next.listSpentMicros + priced.listMicros,
      billedSpentMicros: next.billedSpentMicros + priced.billedMicros,
      turnListSpentMicros: {
        ...next.turnListSpentMicros,
        [turnKey]: (next.turnListSpentMicros[turnKey] ?? 0) + priced.listMicros,
      },
      turnBilledSpentMicros: {
        ...next.turnBilledSpentMicros,
        [turnKey]: (next.turnBilledSpentMicros[turnKey] ?? 0) + priced.billedMicros,
      },
      turnUnknownSettlements: {
        ...next.turnUnknownSettlements,
        [turnKey]: (next.turnUnknownSettlements[turnKey] ?? 0) + (unknown ? 1 : 0),
      },
      unknownSettlements: next.unknownSettlements + (unknown ? 1 : 0),
      settlements: pushCapped(next.settlements, {
        ledgerId: record.ledgerId,
        status: unknown ? 'partial' : 'settled',
        listMicros: priced.listMicros,
        billedMicros: priced.billedMicros,
        costStatus: priced.status,
        components: priced.components,
        unknownComponents: priced.unknownComponents,
        turn: expectation.turn,
        step: expectation.step,
        actualSearchRequests: priced.actualSearchRequests ?? record.actualSearchRequests,
      }, maxRecentIds),
    }
  }

  const cutoff = epochMs(at) - maxPendingAgeMs
  next.pending = next.pending.filter(expectation => expectation.createdAt >= cutoff)
  return {
    state: next,
    page: {
      tornTail: page.tornTail,
      skipped: page.skipped,
      nextOffset: page.nextOffset,
    },
  }
}

export function turnSearchSummary(state, turn) {
  const key = String(turn)
  const settlements = state.settlements.filter(settlement =>
    settlement.turn === turn
    && (settlement.status === 'settled' || settlement.status === 'partial'))
  const componentTotals = {}
  for (const settlement of settlements) {
    for (const component of settlement.components ?? []) {
      const componentKey = component.category === 'search-fee'
        ? 'searchFee'
        : component.category === 'search-token'
          ? bucketKey(component.bucket)
          : 'search'
      const current = componentTotals[componentKey] ?? { listMicros: 0, billedMicros: 0 }
      componentTotals[componentKey] = {
        listMicros: current.listMicros + (component.listMicros ?? 0),
        billedMicros: current.billedMicros + (component.billedMicros ?? 0),
      }
    }
  }
  return {
    turn: turn ?? null,
    listMicros: turn === null ? 0 : state.turnListSpentMicros[key] ?? 0,
    billedMicros: turn === null ? 0 : state.turnBilledSpentMicros[key] ?? 0,
    totalListMicros: state.listSpentMicros ?? 0,
    totalBilledMicros: state.billedSpentMicros ?? 0,
    turnUnknownSettlements: turn === null
      ? 0
      : state.turnUnknownSettlements[key] ?? 0,
    requestCount: state.requestCount ?? 0,
    settledRequestCount: settlements.length,
    componentTotals,
    unknownSettlements: state.unknownSettlements,
  }
}

function bucketKey(bucket) {
  return {
    uncachedInputTokens: 'uncachedInput',
    cacheReadTokens: 'cacheRead',
    cacheWriteTokens: 'cacheWrite',
    outputTokens: 'output',
  }[bucket] ?? 'unknown'
}

function findMatch(pending, record) {
  if (record.correlation?.requestId) {
    const exact = pending.findIndex(item => item.requestId === record.correlation.requestId)
    if (exact >= 0) return exact
  }
  const recordStart = epochMs(record.startedAt)
  return pending.findIndex(item =>
    item.fingerprint === record.requestFingerprint
    && recordStart >= item.createdAt - 5000)
}

function rememberLedgerId(state, ledgerId, cap) {
  return {
    ...state,
    recentLedgerIds: pushCapped(state.recentLedgerIds, ledgerId, cap),
  }
}

function pushCapped(list, value, cap) {
  const next = [...list, value]
  return next.length > cap ? next.slice(next.length - cap) : next
}

function epochMs(value) {
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(String(value))
  if (!Number.isFinite(ms)) throw new TypeError(`invalid timestamp: ${String(value)}`)
  return ms
}
