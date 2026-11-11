import { readFileSync } from 'node:fs'
import { createPricingCatalog, convertAmount, normalizeUsage } from './pricing.js'

/**
 * Fit a profile from local usage and a normalized bill.
 *
 * Strategy:
 * 1. Fold usage ledger upserts by requestKey.
 * 2. Join request-level bill rows when possible.
 * 3. Fit a scalar account multiplier from total billed / total list cost.
 * 4. If enough independent request-level rows exist, fit non-negative bucket
 *    rates and write them back to the profile in per-million currency units.
 *
 * No network call and no LLM is involved.
 */
export function fitProfile({
  catalogDocument,
  usageRecords,
  billRecords,
  profileId,
  minRateFitRows = 8,
  ridge = 0.0001,
}) {
  const catalog = createPricingCatalog(catalogDocument)
  if (!catalog.profiles.has(profileId)) {
    throw new Error(`unknown profile: ${profileId}`)
  }
  const usages = foldUsageRecords(usageRecords).filter(record => record.profileId === profileId)
  const bills = billRecords.filter(record => !record.profile || record.profile === profileId)
  if (usages.length === 0) throw new Error(`no usage records found for profile ${profileId}`)
  if (bills.length === 0) throw new Error(`no bill records found for profile ${profileId}`)

  const matched = joinRequestLevel(usages, bills)
  const aggregateUsageListMicros = usages.reduce((sum, record) => sum + record.listMicros, 0)
  const aggregateBillMicros = bills.reduce((sum, record) => sum + record.amountMicros, 0)
  if (aggregateUsageListMicros <= 0) {
    throw new Error('usage list cost is zero; cannot fit a multiplier')
  }

  const profile = structuredClone(catalogDocument.profiles[profileId])
  const scale = aggregateBillMicros / aggregateUsageListMicros
  profile.accountMultiplier = round(scale, 8)
  profile.accountMultiplierSource = [
    `拟合：账单 ${aggregateBillMicros} micros / 公开价 ${aggregateUsageListMicros} micros`,
    `样本 ${usages.length} 条 usage，${bills.length} 条账单`,
  ].join('；')

  let method = 'aggregate-scale'
  let rateFit = null
  if (matched.length >= minRateFitRows) {
    rateFit = fitRequestLevelRates(matched, catalog, profile, profileId, ridge)
    if (rateFit !== null) {
      method = 'request-level-nonnegative-rates'
      for (const [modelId, fit] of Object.entries(rateFit.models)) {
        if (profile.models?.[modelId] === undefined) continue
        profile.models[modelId] = {
          ...profile.models[modelId],
          ...fit.rates,
          verified: false,
          fit: {
            method,
            rows: fit.rows,
            residualMicros: fit.residualMicros,
            mape: fit.mape,
          },
        }
      }
      profile.accountMultiplier = 1
      profile.accountMultiplierSource = '请求级分桶拟合已把账单差额吸收到 token 单价；账户倍率设为 1。'
    }
  }

  profile.fit = {
    method,
    profileId,
    generatedAt: new Date().toISOString(),
    usageRecords: usages.length,
    billRecords: bills.length,
    requestLevelMatches: matched.length,
    aggregateUsageListMicros,
    aggregateBillMicros,
    aggregateResidualMicros: aggregateBillMicros - aggregateUsageListMicros,
    aggregateScale: round(scale, 8),
    rateFit,
  }

  const output = structuredClone(catalogDocument)
  output.profiles[profileId] = profile
  output.version = `fitted-${new Date().toISOString()}`
  return {
    catalog: output,
    fit: profile.fit,
    profile,
  }
}

export function readUsageLedger(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`invalid usage ledger line ${index + 1}: ${error.message}`)
      }
    })
}

export function foldUsageRecords(records) {
  const byKey = new Map()
  for (const record of records) {
    if (record?.schema !== 'dsh.billing.usage.v1') continue
    if (record.event !== 'upsert') continue
    if (typeof record.requestKey !== 'string') continue
    byKey.set(record.requestKey, record)
  }
  return [...byKey.values()].map(record => ({
    ...record,
    buckets: normalizeUsage(record.buckets),
    listMicros: safeNonNegative(record.listMicros),
    billedMicros: safeNonNegative(record.billedMicros),
  }))
}

function joinRequestLevel(usages, bills) {
  const usageByRequestKey = new Map(usages.map(record => [record.requestKey, record]))
  const usageByTuple = new Map(usages.map(record => [
    tupleKey(record.sessionId, record.turn, record.step),
    record,
  ]))
  const matches = []
  for (const bill of bills) {
    let usage = null
    if (bill.requestKey !== null) usage = usageByRequestKey.get(bill.requestKey) ?? null
    if (usage === null && bill.sessionId !== null && bill.turn !== null && bill.step !== null) {
      usage = usageByTuple.get(tupleKey(bill.sessionId, bill.turn, bill.step)) ?? null
    }
    if (usage !== null) matches.push({ usage, bill })
  }
  return matches
}

function fitRequestLevelRates(matches, catalog, profile, profileId, ridge) {
  const byModel = groupBy(matches, match => match.usage.model)
  const models = {}
  let totalResidual = 0
  let totalTarget = 0
  for (const [modelId, rows] of byModel.entries()) {
    const model = catalog.profiles.get(profileId).models.get(normalizeModel(modelId))
    if (model === undefined) continue
    if (rows.length < 5) continue
    const columns = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    const X = rows.map(({ usage }) => columns.map((bucket) => {
      const peak = usage.peak?.multiplier ?? 1
      return usage.buckets[bucket] * peak
    }))
    const y = rows.map(({ bill }) => bill.amountMicros)
    const initial = [
      model.input ?? 0,
      model.cacheRead ?? model.input ?? 0,
      model.cacheWrite ?? model.input ?? 0,
      model.output ?? 0,
    ].map(rate => convertToDisplayMicrosPerToken(rate, profile.currency, catalog.displayCurrency, catalog.usdToCny))
    const fitted = nonNegativeLeastSquares(X, y, initial, ridge)
    if (fitted === null) continue
    const predicted = X.map(row => dot(row, fitted.coefficients))
    const residualMicros = y.reduce((sum, value, index) => sum + Math.abs(value - predicted[index]), 0)
    const mape = y.reduce((sum, value, index) => {
      if (value === 0) return sum
      return sum + Math.abs(value - predicted[index]) / Math.abs(value)
    }, 0) / Math.max(1, y.filter(value => value !== 0).length)
    totalResidual += residualMicros
    totalTarget += y.reduce((sum, value) => sum + Math.abs(value), 0)
    models[modelId] = {
      rows: rows.length,
      residualMicros: Math.round(residualMicros),
      mape: round(mape, 6),
      rates: {
        input: round(fromDisplayMicrosPerToken(fitted.coefficients[0], profile.currency, catalog.displayCurrency, catalog.usdToCny), 8),
        cacheRead: round(fromDisplayMicrosPerToken(fitted.coefficients[1], profile.currency, catalog.displayCurrency, catalog.usdToCny), 8),
        cacheWrite: round(fromDisplayMicrosPerToken(fitted.coefficients[2], profile.currency, catalog.displayCurrency, catalog.usdToCny), 8),
        output: round(fromDisplayMicrosPerToken(fitted.coefficients[3], profile.currency, catalog.displayCurrency, catalog.usdToCny), 8),
      },
    }
  }
  if (Object.keys(models).length === 0) return null
  return {
    method: 'nonnegative-bucket-regression',
    models,
    residualMicros: Math.round(totalResidual),
    mape: round(totalResidual / Math.max(1, totalTarget), 6),
  }
}

function nonNegativeLeastSquares(X, y, initial, ridge) {
  const columns = X[0]?.length ?? 0
  if (columns === 0 || X.length < 2) return null
  const coefficients = initial.map(value => Math.max(0, Number.isFinite(value) ? value : 0))
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    let maxChange = 0
    for (let column = 0; column < columns; column += 1) {
      let numerator = 0
      let denominator = ridge
      for (let row = 0; row < X.length; row += 1) {
        const x = X[row][column]
        if (x === 0) continue
        const partial = y[row] - dot(X[row], coefficients) + x * coefficients[column]
        numerator += x * partial
        denominator += x * x
      }
      const next = denominator === 0 ? coefficients[column] : Math.max(0, numerator / denominator)
      maxChange = Math.max(maxChange, Math.abs(next - coefficients[column]))
      coefficients[column] = next
    }
    if (maxChange < 1e-10) break
  }
  return { coefficients }
}

function convertToDisplayMicrosPerToken(ratePer1M, fromCurrency, toCurrency, usdToCny) {
  return convertAmount(ratePer1M, fromCurrency, toCurrency, usdToCny) ?? 0
}

function fromDisplayMicrosPerToken(rate, profileCurrency, displayCurrency, usdToCny) {
  return convertAmount(rate, displayCurrency, profileCurrency, usdToCny) ?? 0
}

function dot(left, right) {
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index]
  return sum
}

function tupleKey(sessionId, turn, step) {
  return `${sessionId}:${turn}:${step}`
}

function normalizeModel(value) {
  return String(value ?? '').trim().toLowerCase()
}

function groupBy(values, keyOf) {
  const groups = new Map()
  for (const value of values) {
    const key = keyOf(value)
    const list = groups.get(key) ?? []
    list.push(value)
    groups.set(key, list)
  }
  return groups
}

function safeNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
