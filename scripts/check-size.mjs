// Fails when the booking page's initial JavaScript exceeds its budget (SPEC §10: ≤ 120 KB gzip).
// "Initial" = the booking entry chunk plus every chunk it imports statically; lazy chunks excluded.
// Run after `npm run build` (reads dist/.vite/manifest.json).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 120 * 1024
const DIST = 'dist'
const ENTRY = 'index.html'

const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8'))
if (!manifest[ENTRY]) {
  console.error(`No "${ENTRY}" entry in the Vite manifest. Did the build run?`)
  process.exit(1)
}

/** @type {Set<string>} */
const seen = new Set()
/** @type {string[]} */
const files = []
/** @param {string} key */
const visit = (key) => {
  if (seen.has(key)) return
  seen.add(key)
  const chunk = manifest[key]
  if (!chunk) return
  if (chunk.file.endsWith('.js')) files.push(chunk.file)
  for (const imported of chunk.imports ?? []) visit(imported)
}
visit(ENTRY)

let total = 0
for (const file of files) {
  const bytes = gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length
  total += bytes
  console.log(`${(bytes / 1024).toFixed(1).padStart(7)} KB  ${file}`)
}
console.log(
  `${(total / 1024).toFixed(1).padStart(7)} KB  total (budget ${BUDGET_BYTES / 1024} KB gzip)`,
)

if (total > BUDGET_BYTES) {
  console.error('Booking page JavaScript is over budget.')
  process.exit(1)
}
