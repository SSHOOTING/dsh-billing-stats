#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { importBillFile } from '../src/bill-import.js'

const args = parseArgs(process.argv.slice(2))
if (args.help === true || typeof args.bill !== 'string') {
  console.log(`用法：
  npm run bill:import -- --bill <账单.csv|json|jsonl> --out <归一化.jsonl> [--currency CNY] [--display-currency CNY] [--usd-to-cny 7.2]
`)
  process.exit(args.help === true ? 0 : 1)
}

const billPath = resolve(args.bill)
const outPath = resolve(String(args.out ?? 'data/bill.normalized.jsonl'))
const records = importBillFile(billPath, {
  currency: args.currency ?? 'CNY',
  displayCurrency: args['display-currency'] ?? 'CNY',
  usdToCny: args['usd-to-cny'] === undefined ? 7.2 : Number(args['usd-to-cny']),
})
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, records.map(record => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''), 'utf8')

const amounts = records.reduce((sum, record) => sum + record.amountMicros, 0)
const requestRows = records.filter(record => record.level === 'request').length
console.log(JSON.stringify({
  ok: true,
  bill: billPath,
  out: outPath,
  records: records.length,
  requestRows,
  aggregateRows: records.length - requestRows,
  totalDisplayMicros: amounts,
  displayCurrency: args['display-currency'] ?? 'CNY',
}, null, 2))

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      result[key] = true
    } else {
      result[key] = next
      index += 1
    }
  }
  return result
}
