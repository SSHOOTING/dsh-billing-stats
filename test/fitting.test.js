import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeBillRecords, parseCsv } from '../src/bill-import.js'
import { fitProfile, foldUsageRecords } from '../src/fitting.js'

const catalog = {
  schemaVersion: 1,
  displayCurrency: 'CNY',
  usdToCny: 7.2,
  defaultProfile: 'official',
  providerProfiles: { deepseek: 'official' },
  profiles: {
    official: {
      label: 'Official',
      currency: 'CNY',
      accountMultiplier: 1,
      models: {
        flash: {
          aliases: ['deepseek-v4.1-flash'],
          input: 1,
          cacheRead: 0.02,
          cacheWrite: 1,
          output: 4,
          verified: true,
        },
      },
    },
  },
}

test('imports quoted CSV and normalizes currencies', () => {
  const rows = parseCsv('request_id,provider,model,currency,amount,input_tokens,output_tokens\n'
    + 'r1,deepseek,deepseek-v4.1-flash,USD,"0.001",100,20\n')
  const records = normalizeBillRecords(rows, { displayCurrency: 'CNY', usdToCny: 7.2 })
  assert.equal(records.length, 1)
  assert.equal(records[0].amountMicros, 7_200)
  assert.equal(records[0].level, 'request')
})

test('folds usage ledger upserts by request key', () => {
  const folded = foldUsageRecords([
    { schema: 'dsh.billing.usage.v1', event: 'upsert', requestKey: 'a', listMicros: 10 },
    { schema: 'dsh.billing.usage.v1', event: 'upsert', requestKey: 'a', listMicros: 20 },
    { schema: 'dsh.billing.usage.v1', event: 'upsert', requestKey: 'b', listMicros: 5 },
  ])
  assert.equal(folded.length, 2)
  assert.equal(folded.find(record => record.requestKey === 'a').listMicros, 20)
})

test('aggregate bill fits a scalar account multiplier', () => {
  const usageRecords = [{
    schema: 'dsh.billing.usage.v1',
    event: 'upsert',
    requestKey: 's:1:1',
    profileId: 'official',
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    status: 'priced',
    buckets: { uncachedInputTokens: 1000, outputTokens: 100 },
    listMicros: 1000,
    billedMicros: 1000,
    peak: { multiplier: 1 },
  }]
  const billRecords = [{
    profile: 'official',
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    amountMicros: 600,
    requestId: null,
    requestKey: null,
    sessionId: null,
    turn: null,
    step: null,
  }]
  const result = fitProfile({ catalogDocument: catalog, usageRecords, billRecords, profileId: 'official' })
  assert.equal(result.fit.method, 'aggregate-scale')
  assert.equal(result.profile.accountMultiplier, 0.6)
})
