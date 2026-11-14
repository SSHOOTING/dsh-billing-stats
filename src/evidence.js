/**
 * Billing evidence hierarchy and the last-resort local estimator.
 *
 * Priority:
 *   request-level bill > provider usage > local text estimate > unknown
 *
 * The estimator is deliberately simple and transparent. It is never presented
 * as official usage; callers must keep `costSource = "estimate"` attached.
 */

export const COST_SOURCES = Object.freeze(['bill', 'usage', 'estimate', 'unknown'])
export const COST_SOURCE_PRIORITY = Object.freeze({
  bill: 3,
  usage: 2,
  estimate: 1,
  unknown: 0,
})

const SOURCE_LABELS = Object.freeze({
  bill: '账单明细',
  usage: '官方用量',
  estimate: '文本估算',
  unknown: '未知',
})

export function emptyCostSourceStats() {
  return Object.fromEntries(COST_SOURCES.map(source => [
    source,
    { requestCount: 0, listMicros: 0, billedMicros: 0 },
  ]))
}

export function addCostSourceStats(stats, source, { listMicros = 0, billedMicros = 0 } = {}) {
  const next = cloneCostSourceStats(stats)
  const key = normalizeSource(source)
  next[key].requestCount += 1
  next[key].listMicros += safeNonNegative(listMicros)
  next[key].billedMicros += safeNonNegative(billedMicros)
  return next
}

export function subtractCostSourceStats(stats, source, { listMicros = 0, billedMicros = 0 } = {}) {
  const next = cloneCostSourceStats(stats)
  const key = normalizeSource(source)
  next[key].requestCount = Math.max(0, next[key].requestCount - 1)
  next[key].listMicros = Math.max(0, next[key].listMicros - safeNonNegative(listMicros))
  next[key].billedMicros = Math.max(0, next[key].billedMicros - safeNonNegative(billedMicros))
  return next
}

export function mergeCostSourceStats(left, right) {
  const next = cloneCostSourceStats(left)
  for (const source of COST_SOURCES) {
    const value = right?.[source]
    if (value === undefined) continue
    next[source].requestCount += safeNonNegative(value.requestCount)
    next[source].listMicros += safeNonNegative(value.listMicros)
    next[source].billedMicros += safeNonNegative(value.billedMicros)
  }
  return next
}

export function costSourceLabel(source) {
  return SOURCE_LABELS[normalizeSource(source)]
}

export function summarizeCostSources(stats) {
  const normalized = cloneCostSourceStats(stats)
  return COST_SOURCES
    .filter(source => normalized[source].requestCount > 0)
    .map(source => ({
      source,
      label: SOURCE_LABELS[source],
      ...normalized[source],
    }))
}

export function emptyTextEvidence() {
  return { cjkChars: 0, otherChars: 0 }
}

export function countTextEvidence(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  let cjkChars = 0
  let otherChars = 0
  for (const character of value) {
    if (isCjk(character)) cjkChars += 1
    else otherChars += 1
  }
  return { cjkChars, otherChars }
}

export function addTextEvidence(left, right) {
  return {
    cjkChars: safeNonNegative(left?.cjkChars) + safeNonNegative(right?.cjkChars),
    otherChars: safeNonNegative(left?.otherChars) + safeNonNegative(right?.otherChars),
  }
}

export function estimateTokens(evidence) {
  const cjkChars = safeNonNegative(evidence?.cjkChars)
  const otherChars = safeNonNegative(evidence?.otherChars)
  return Math.ceil(cjkChars + otherChars / 4)
}

export function estimateUsageForRequest(state, event) {
  const inputEvidence = addTextEvidence(state.modelText, state.requestHeaderText)
  const outputEvidence = outputEvidenceFromEvent(event)
  const inputTokens = estimateTokens(inputEvidence)
  const outputTokens = estimateTokens(outputEvidence)
  return {
    usage: {
      uncachedInputTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens,
    },
    evidence: {
      method: 'character-heuristic-v1',
      inputEvidence,
      outputEvidence,
      inputTokens,
      outputTokens,
    },
  }
}

export function contextEvidenceFromEvent(event) {
  const content = messageContent(event)
  if (content === undefined) return emptyTextEvidence()
  return countTextEvidence(contentText(content, {
    includeReasoning: false,
    includeToolPayload: false,
  }))
}

export function outputEvidenceFromEvent(event) {
  const content = messageContent(event)
  if (content === undefined) return emptyTextEvidence()
  return countTextEvidence(contentText(content, {
    includeReasoning: true,
    includeToolPayload: true,
  }))
}

export function headerEvidenceFromEvent(event) {
  const header = event.data?.header
  if (header === null || typeof header !== 'object') return emptyTextEvidence()
  try {
    return countTextEvidence(JSON.stringify(header))
  } catch {
    return emptyTextEvidence()
  }
}

export function messageIdFromEvent(event) {
  return stringOrNull(event.data?.message?.id)
    ?? stringOrNull(event.data?.id)
    ?? stringOrNull(event.id)
}

function messageContent(event) {
  if (event.data?.message?.content !== undefined) return event.data.message.content
  if (event.data?.content !== undefined) return event.data.content
  return undefined
}

function contentText(content, { includeReasoning, includeToolPayload }) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' || (includeReasoning && block.type === 'reasoning')) {
      if (typeof block.text === 'string') parts.push(block.text)
      continue
    }
    if (includeToolPayload && (
      block.type === 'tool-call'
      || block.type === 'tool_call'
      || block.type === 'tool-result'
      || block.type === 'tool_result'
    )) {
      try {
        parts.push(JSON.stringify(block))
      } catch {
        // Ignore non-serializable tool payloads.
      }
    }
  }
  return parts.join('\n')
}

function cloneCostSourceStats(stats) {
  return Object.fromEntries(COST_SOURCES.map(source => {
    const value = stats?.[source]
    return [source, {
      requestCount: safeNonNegative(value?.requestCount),
      listMicros: safeNonNegative(value?.listMicros),
      billedMicros: safeNonNegative(value?.billedMicros),
    }]
  }))
}

function normalizeSource(source) {
  return Object.hasOwn(SOURCE_LABELS, source) ? source : 'unknown'
}

function safeNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function isCjk(character) {
  const codePoint = character.codePointAt(0)
  return (codePoint >= 0x3400 && codePoint <= 0x4DBF)
    || (codePoint >= 0x4E00 && codePoint <= 0x9FFF)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0x20000 && codePoint <= 0x2FA1F)
}
