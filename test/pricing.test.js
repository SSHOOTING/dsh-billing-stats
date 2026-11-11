import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPricingCatalog,
  formatMoney,
  normalizeUsage,
  priceSearchLedgerRecord,
  priceUsage,
} from '../src/pricing.js'

const catalog = createPricingCatalog({
  displayCurrency: 'CNY',
  usdToCny: 7.2,
  defaultProfile: 'official',
  providerProfiles: { deepseek: 'official', 'opencode-go': 'subscription' },
  profiles: {
    official: {
      label: 'Official',
      currency: 'CNY',
      accountMultiplier: 1,
      searchMultiplier: 1,
      verified: true,
      models: {
        flash: {
          aliases: ['deepseek-v4.1-flash'],
          input: 1,
          cacheRead: 0.02,
          cacheWrite: 1,
          output: 4,
          peakMultiplier: 2,
          peakWindows: [['09:00', '12:00']],
          verified: true,
        },
      },
      searchFees: {
        'deepseek-tools-search': { perRequest: 0.005, currency: 'CNY', verified: false },
      },
    },
    subscription: {
      label: 'Subscription',
      currency: 'USD',
      accountMultiplier: 0.6,
      searchMultiplier: 0.6,
      verified: true,
      models: {
        flash: {
          aliases: ['deepseek-v4.1-flash'],
          input: 0.15,
          cacheRead: 0.003,
          cacheWrite: 0.15,
          output: 0.6,
          verified: true,
        },
      },
    },
  },
})

test('prices four disjoint buckets and applies peak multiplier', () => {
  const result = priceUsage(catalog, {
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    usage: {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    },
    at: new Date('2026-11-10T02:00:00Z'),
  })
  assert.equal(result.profileId, 'official')
  assert.equal(result.peak.multiplier, 2)
  // (1 + 0.02 + 1 + 4) CNY × 2 = ¥12.04.
  assert.equal(result.listMicros, 12_040_000)
  assert.equal(result.billedMicros, 12_040_000)
  assert.equal(result.status, 'priced')
})

test('applies account multiplier without changing list cost', () => {
  const result = priceUsage(catalog, {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    at: new Date('2026-11-10T05:00:00Z'),
  })
  // (0.15 + 0.6) USD × 7.2 = ¥5.4 list; account 0.6 = ¥3.24.
  assert.equal(result.listMicros, 5_400_000)
  assert.equal(result.billedMicros, 3_240_000)
})

test('missing price is unknown rather than zero', () => {
  const result = priceUsage(catalog, {
    provider: 'deepseek',
    model: 'missing-model',
    usage: { inputTokens: 10, outputTokens: 2 },
  })
  assert.equal(result.status, 'unknown')
  assert.equal(result.listMicros, 0)
  assert.ok(result.unknownComponents.length > 0)
})

test('normalizes nested OpenCode usage without double counting reasoning', () => {
  assert.deepEqual(normalizeUsage({
    opencode: { tokens: { input: 10, cache_read: 3, cache_write: 2, output: 7 } },
    reasoningTokens: 999,
  }), {
    uncachedInputTokens: 10,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    outputTokens: 7,
  })
})

test('prices search attempts and fixed search fees together', () => {
  const priced = priceSearchLedgerRecord(catalog, {
    ledgerId: 'search-1',
    startedAt: '2026-11-10T02:00:00Z',
    endedAt: '2026-11-10T02:00:01Z',
    mode: 'opencode-haiku',
    actualSearchRequests: 1,
    attempts: [{
      provider: 'deepseek',
      model: 'deepseek-v4.1-flash',
      engine: 'deepseek-tools-search',
      usage: { inputTokens: 100, outputTokens: 20 },
      searchRequests: 1,
    }],
  })
  assert.equal(priced.status, 'priced')
  assert.ok(priced.components.some(component => component.kind === 'token'))
  assert.ok(priced.components.some(component => component.kind === 'fixed-search-fee'))
  assert.ok(priced.listMicros > 0)
})

test('formats compact amounts', () => {
  assert.equal(formatMoney(1_000_000, 'CNY'), '¥1.00')
  assert.equal(formatMoney(1_000, 'CNY'), '¥0.001000')
})

test('counts model definitions separately from aliases', () => {
  assert.equal(catalog.profiles.get('official').modelCount, 1)
  assert.equal(catalog.profiles.get('official').models.size, 2)
})
