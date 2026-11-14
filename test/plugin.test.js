import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { apply } from '../src/index.js'
import {
  applyBillingEvent,
  initBillingState,
} from '../src/ledger.js'

test('host plugin registers only observational projection, command, and session events', () => {
  let projection
  let command
  const listeners = new Map()
  const ctx = {
    sessionProjections: {
      register(definition) {
        projection = definition
        return () => {}
      },
      stateOf() {
        return undefined
      },
    },
    commands: {
      register(definition) {
        command = definition
        return () => {}
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { searchLedgerEnabled: false })
  assert.equal(projection.key, 'billing')
  assert.equal(command.name, 'cost')
  assert.equal(listeners.has('agent/request'), false)
  assert.equal(listeners.has('tools/pre-execute'), false)
  assert.equal(listeners.has('session/event'), true)
})

test('client bundle registers composer and per-turn money views', () => {
  let loaded
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          loaded = value
        },
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
  assert.equal(loaded.id, 'dsh-billing-stats')
  const client = loaded.factory(() => ({ createElement() { return {} } }))
  const registrations = []
  const injectedSlots = []
  const ctx = {
    slots: {
      inject(slot, install) {
        injectedSlots.push(slot)
        install()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(injectedSlots, [
    'conversation.composer.dock',
    'conversation.chat.assistant-actions',
  ])
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.id, 'billing-stats')
  assert.equal(typeof registrations[0].component, 'function')
  assert.equal(registrations[1].options.id, 'billing-turn-amount')
  assert.equal(typeof registrations[1].component, 'function')
})

test('client distinguishes unknown cost from a real zero amount', () => {
  let loaded
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          loaded = value
        },
      },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useCallback(callback) {
      return callback
    },
    useEffect() {},
  }
  const client = loaded.factory(name => name === 'react'
    ? React
    : { createPortal(node) { return node } })
  const registrations = []
  client.apply({
    slots: {
      inject(slot, install) {
        install()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  })
  const turnCost = {
    turn: 1,
    billedMicros: 0,
    listMicros: 0,
    requestCount: 1,
    unknown: true,
    unknownComponents: ['usage'],
    buckets: {},
    mainComponentTotals: {},
    searchComponentTotals: {},
    searchBilledMicros: 0,
    searchRequestCount: 0,
  }
  const projection = {
    billedSpentMicros: 0,
    listSpentMicros: 0,
    componentTotals: {},
    unknown: true,
    unknownComponents: ['usage'],
    turnCosts: { 1: turnCost },
  }
  const sessionNode = registrations[0].component({
    useProjection: () => projection,
  })
  assert.match(collectText(sessionNode), /会话 金额未知/u)
  assert.equal(findByProp(sessionNode, 'data-billing-composer-pill')?.props['aria-label'], '会话费用未知')

  const estimateStats = {
    bill: { requestCount: 0, listMicros: 0, billedMicros: 0 },
    usage: { requestCount: 0, listMicros: 0, billedMicros: 0 },
    estimate: { requestCount: 1, listMicros: 123_456, billedMicros: 123_456 },
    unknown: { requestCount: 0, listMicros: 0, billedMicros: 0 },
  }
  const estimateCost = {
    ...turnCost,
    billedMicros: 123_456,
    listMicros: 123_456,
    unknown: false,
    unknownComponents: [],
    costSourceStats: estimateStats,
  }
  const estimateProjection = {
    ...projection,
    billedSpentMicros: 123_456,
    listSpentMicros: 123_456,
    unknown: false,
    unknownComponents: [],
    costSourceStats: estimateStats,
    turnCosts: { 1: estimateCost },
  }
  const estimateSessionNode = registrations[0].component({
    useProjection: () => estimateProjection,
  })
  assert.match(collectText(estimateSessionNode), /会话 ¥0\.1235 · 文本估算/u)
  assert.equal(
    findByProp(estimateSessionNode, 'data-billing-composer-pill')?.props['aria-label'],
    '会话费用 ¥0.1235，文本估算',
  )

  const snapshot = {
    timeline: {
      turnOrder: [1],
      turns: new Map([[
        1,
        {
          data: new Map([[
            'turn-tail',
            { closing: { finalNode: { messageId: 'message-1' } } },
          ]]),
        },
      ]]),
    },
  }
  const turnNode = registrations[1].component({
    messageId: 'message-1',
    useChat: selector => selector(snapshot),
    useProjection: () => projection,
  })
  assert.match(collectText(turnNode), /用量 金额未知/u)
  assert.equal(findByProp(turnNode, 'data-billing-turn-pill')?.props['aria-label'], '本轮用量费用未知')

  const estimateTurnNode = registrations[1].component({
    messageId: 'message-1',
    useChat: selector => selector(snapshot),
    useProjection: () => estimateProjection,
  })
  assert.match(collectText(estimateTurnNode), /用量 ¥0\.1235 · 文本估算/u)
  assert.equal(
    findByProp(estimateTurnNode, 'data-billing-turn-pill')?.props['aria-label'],
    '本轮用量费用 ¥0.1235，文本估算',
  )
})

test('host command exposes profiles, explanation, and profile switching', () => {
  let command
  let currentState = initBillingState({ id: 'session-command' })
  const ctx = {
    sessionProjections: {
      register() {
        return () => {}
      },
      stateOf() {
        return currentState
      },
    },
    commands: {
      register(definition) {
        command = definition
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { searchLedgerEnabled: false })

  const invocation = {
    rawInput: 'profiles',
    agent: { session: { id: 'session-command' } },
  }
  const profiles = command.handler(invocation)
  assert.equal(profiles.kind, 'success')
  assert.match(profiles.text, /模型 2 个/u)
  assert.doesNotMatch(profiles.text, /模型 11 个|模型 12 个/u)

  currentState = applyBillingEvent(currentState, {
    type: 'turn/start',
    data: { turn: 1 },
    time: 1,
  }, { pricing: null, displayCurrency: 'CNY', maxRecentRequests: 20 })

  currentState = applyBillingEvent(currentState, {
    type: 'command/run',
    data: { name: 'cost', args: 'profile opencode-go' },
    time: 2,
  }, {
    pricing: {
      profiles: new Map([
        ['deepseek-official', {}],
        ['opencode-go', {}],
      ]),
    },
  })
  assert.equal(currentState.activeProfileOverride, 'opencode-go')

  const switched = command.handler({
    rawInput: 'profile opencode-go',
    agent: { session: { id: 'session-command' } },
  })
  assert.equal(switched.kind, 'success')
  assert.match(switched.text, /opencode-go/u)
})

function collectText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  return (node.children ?? []).map(collectText).join('')
}

function findByProp(node, prop) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.props?.[prop] !== undefined) return node
  for (const child of node.children ?? []) {
    const found = findByProp(child, prop)
    if (found !== null) return found
  }
  return null
}
