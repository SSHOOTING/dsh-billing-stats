import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BILLING_PROJECTION_KEY,
  applyBillingEvent,
  billingView,
  initBillingState,
  renderLastRequest,
} from '../src/ledger.js'
import { createPricingCatalog } from '../src/pricing.js'

const pricing = createPricingCatalog({
  displayCurrency: 'CNY',
  usdToCny: 7.2,
  defaultProfile: 'official',
  providerProfiles: { deepseek: 'official' },
  profiles: {
    official: {
      label: 'Official',
      currency: 'CNY',
      accountMultiplier: 1,
      verified: true,
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
})
const env = { pricing, displayCurrency: 'CNY', maxRecentRequests: 20 }

test('folds usage into turn and session totals', () => {
  let state = initBillingState({ id: 's1' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, env)
  state = applyBillingEvent(state, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } } },
  }, env)
  state = applyBillingEvent(state, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    },
    time: '2026-11-10T05:00:00Z',
  }, env)
  state = applyBillingEvent(state, { type: 'turn/end', data: { turn: 1 }, time: 3 }, env)
  const view = billingView(state, env)
  assert.equal(view.turnPhase, 'ended')
  assert.equal(view.billedSpentMicros, 5_000_000)
  assert.equal(view.turnBilledMicros, 5_000_000)
  assert.equal(view.lastRequest.status, 'priced')
  assert.equal(view.lastTurn.requestCount, 1)
})

test('replaces duplicate usage for the same turn/step instead of double counting', () => {
  let state = initBillingState({ id: 's2' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, env)
  const base = {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    },
    time: 2,
  }
  state = applyBillingEvent(state, base, env)
  const first = state.turnBilledSpentMicros
  state = applyBillingEvent(state, base, env)
  assert.equal(state.turnBilledSpentMicros, first)
  assert.equal(state.turnRequestCount, 1)
  assert.equal(state.recentRequests.length, 1)
})

test('unknown usage counts as unknown and never zero-priced success', () => {
  let state = initBillingState({ id: 's3' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, env)
  state = applyBillingEvent(state, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } } },
    time: 2,
  }, env)
  const view = billingView(state, env)
  assert.equal(view.unknown, true)
  assert.equal(view.unpricedRequestCount, 1)
  assert.equal(view.lastRequest.status, 'unknown')
})

test('duplicate partial pricing replaces the prior request without count drift', () => {
  const partialPricing = createPricingCatalog({
    displayCurrency: 'CNY',
    defaultProfile: 'official',
    providerProfiles: { deepseek: 'official' },
    profiles: {
      official: {
        accountMultiplier: 1,
        models: {
          flash: {
            aliases: ['deepseek-v4.1-flash'],
            input: 1,
            cacheRead: 0.02,
            cacheWrite: 1,
          },
        },
      },
    },
  })
  const partialEnv = { ...env, pricing: partialPricing }
  const event = {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1000, outputTokens: 10 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    },
    time: 2,
  }
  let state = initBillingState({ id: 's4' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, partialEnv)
  state = applyBillingEvent(state, event, partialEnv)
  state = applyBillingEvent(state, event, partialEnv)
  const view = billingView(state, partialEnv)
  assert.equal(view.turnRequestCount, 1)
  assert.equal(view.pricedRequestCount, 0)
  assert.equal(view.unpricedRequestCount, 1)
  assert.equal(state.turnPricedRequestCount, 0)
  assert.equal(state.turnUnpricedRequestCount, 1)
})

test('explain renders human labels for token buckets', () => {
  let state = initBillingState({ id: 's5' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, env)
  state = applyBillingEvent(state, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 10 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    },
    time: 2,
  }, env)
  const text = renderLastRequest(billingView(state, env))
  assert.match(text, /未缓存输入/u)
  assert.match(text, /缓存读取/u)
  assert.match(text, /输出/u)
  assert.doesNotMatch(text, /uncachedInputTokens|cacheReadTokens|outputTokens/u)
})

test('exposes per-turn money, token buckets, routes, and search totals', () => {
  let state = initBillingState({ id: 's6' })
  state = applyBillingEvent(state, { type: 'turn/start', data: { turn: 1 }, time: 1 }, env)
  state = applyBillingEvent(state, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 10 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
    },
    time: 2,
  }, env)
  state = applyBillingEvent(state, { type: 'turn/end', data: { turn: 1 }, time: 3 }, env)
  const view = billingView(state, env, null, null, {
    1: {
      listMicros: 5000,
      billedMicros: 3000,
      settledRequestCount: 1,
      unknownSettlements: 0,
      componentTotals: {
        searchFee: { listMicros: 5000, billedMicros: 3000 },
      },
    },
  })
  const cost = view.turnCosts['1']
  assert.equal(cost.turn, 1)
  assert.equal(cost.billedMicros, view.turnBilledMicros + 3000)
  assert.equal(cost.searchBilledMicros, 3000)
  assert.equal(cost.searchRequestCount, 1)
  assert.deepEqual(cost.routes, ['deepseek/deepseek-v4.1-flash'])
  assert.equal(cost.buckets.uncachedInputTokens, 1000)
  assert.equal(cost.buckets.cacheReadTokens, 200)
  assert.equal(cost.buckets.outputTokens, 10)
  assert.equal(cost.mainComponentTotals.uncachedInput.billedMicros, 1000)
  assert.equal(cost.searchComponentTotals.searchFee.billedMicros, 3000)
})

test('projection key is stable', () => {
  assert.equal(BILLING_PROJECTION_KEY, 'billing')
})
