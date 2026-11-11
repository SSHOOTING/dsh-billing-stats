#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { importBillFile } from '../src/bill-import.js'
import { fitProfile, readUsageLedger } from '../src/fitting.js'

const args = parseArgs(process.argv.slice(2))
if (args.help === true || typeof args.usage !== 'string' || typeof args.bill !== 'string') {
  console.log(`用法：
  npm run bill:fit -- --usage <usage-ledger.jsonl> --bill <账单.csv|json|jsonl> --profile <profile-id> [--catalog pricing/profiles.json] [--out pricing/fitted/profile.json] [--min-rate-fit-rows 8]
`)
  process.exit(args.help === true ? 0 : 1)
}

const catalogPath = resolve(String(args.catalog ?? 'pricing/profiles.json'))
const usagePath = resolve(args.usage)
const billPath = resolve(args.bill)
const outPath = resolve(String(args.out ?? `pricing/fitted/${args.profile}.json`))
const catalogDocument = JSON.parse(readFileSync(catalogPath, 'utf8'))
const billRecords = importBillFile(billPath, {
  currency: args.currency ?? catalogDocument.displayCurrency ?? 'CNY',
  displayCurrency: catalogDocument.displayCurrency ?? 'CNY',
  usdToCny: catalogDocument.usdToCny ?? 7.2,
})
const usageRecords = readUsageLedger(usagePath)
const result = fitProfile({
  catalogDocument,
  usageRecords,
  billRecords,
  profileId: String(args.profile),
  minRateFitRows: Number(args['min-rate-fit-rows'] ?? 8),
})
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(result.catalog, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({
  ok: true,
  out: outPath,
  ...result.fit,
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
