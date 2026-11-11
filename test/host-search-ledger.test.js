import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initHostSearchLedgerState,
  observeSearchRequest,
  pollHostSearchLedger,
  turnSearchSummary,
} from '../src/host-search-ledger.js'
import { fingerprintSearchRequest } from '../src/search-ledger.js'

test('matches a search request fingerprint to its ledger record and turn totals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-billing-search-'))
  const ledgerPath = join(directory, 'search-ledger.jsonl')
  try {
    const body = { model: 'search-helper', messages: [{ role: 'user', content: 'weather' }] }
    const record = {
      schema: 'dsh.search-ledger.v1',
      ledgerId: 'ledger-1',
      startedAt: '2026-11-11T03:00:00.000Z',
      requestFingerprint: fingerprintSearchRequest(body),
      attempts: [],
    }
    writeFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8')

    let state = initHostSearchLedgerState()
    state = observeSearchRequest(state, {
      body,
      sessionId: 'session-1',
      turn: 2,
      step: 4,
      at: Date.parse('2026-11-11T03:00:00.000Z'),
    })
    const result = pollHostSearchLedger(state, {
      ledgerPath,
      at: Date.parse('2026-11-11T03:00:01.000Z'),
      priceRecord: () => ({
        status: 'priced',
        listMicros: 1200,
        billedMicros: 720,
        components: [{
          category: 'search-fee',
          listMicros: 1200,
          billedMicros: 720,
        }],
        unknownComponents: [],
        actualSearchRequests: 1,
      }),
    })

    assert.equal(result.state.pending.length, 0)
    assert.equal(result.state.settlements.length, 1)
    assert.equal(result.state.settlements[0].status, 'settled')
    assert.equal(result.state.settlements[0].turn, 2)
    const summary = turnSearchSummary(result.state, 2)
    assert.equal(summary.listMicros, 1200)
    assert.equal(summary.billedMicros, 720)
    assert.equal(summary.settledRequestCount, 1)
    assert.equal(summary.componentTotals.searchFee.billedMicros, 720)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
