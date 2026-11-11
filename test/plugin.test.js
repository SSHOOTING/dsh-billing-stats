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

test('client bundle registers only a dock card', () => {
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
  assert.equal(loaded.id, 'dsh-billing-attribution')
  const client = loaded.factory(() => ({ createElement() { return {} } }))
  const registrations = []
  const ctx = {
    slots: {
      inject(slot, install) {
        install()
        assert.equal(slot, 'conversation.input.dock')
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
  }
  client.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.id, 'billing-attribution')
  assert.equal(typeof registrations[0].component, 'function')
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
