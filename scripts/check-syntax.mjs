#!/usr/bin/env node
import { readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const skipDirectories = new Set(['.git', 'data', 'node_modules', 'reports'])
const files = []

for (const directory of ['src', 'bin', 'scripts', 'test']) {
  collect(join(root, directory))
}

if (files.length === 0) {
  console.error('check-syntax: no JavaScript files found')
  process.exit(1)
}

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  const label = relative(root, file)
  if (result.status === 0) {
    console.log(`ok ${label}`)
    continue
  }
  failed = true
  console.error(`failed ${label}`)
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

console.log(`checked ${files.length} files`)
process.exit(failed ? 1 : 0)

function collect(path) {
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirectories.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      collect(child)
      continue
    }
    if (!entry.isFile()) continue
    if (!['.js', '.mjs', '.cjs'].includes(extname(entry.name))) continue
    if (statSync(child).isFile()) files.push(child)
  }
}
