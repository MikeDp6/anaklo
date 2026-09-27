// Regenerates src/shared/lib/database.types.ts from the LOCAL database (CLAUDE.md rule 1).
// Writes only on success, in UTF-8: a shell `>` would leave an empty file when the CLI fails
// and, in Windows PowerShell 5.1, would write UTF-16.
// `--check` compares instead of writing and fails when the committed file is stale (used in CI).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TARGET = 'src/shared/lib/database.types.ts'
const check = process.argv.includes('--check')

// One command string: npx is a .cmd on Windows and needs a shell; no user input is involved.
const result = spawnSync('npx supabase gen types typescript --local', {
  encoding: 'utf8',
  shell: true,
  maxBuffer: 16 * 1024 * 1024,
})

if (result.status !== 0 || !result.stdout.includes('export type Database')) {
  console.error(result.stderr || 'supabase gen types failed (is the local stack running?)')
  process.exit(1)
}

const generated = result.stdout.replace(/\r\n/g, '\n')

if (check) {
  const current = readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n')
  if (current.trim() !== generated.trim()) {
    console.error(`${TARGET} is out of date. Run: npm run gen:types`)
    process.exit(1)
  }
  console.log(`${TARGET} is up to date.`)
} else {
  writeFileSync(TARGET, generated, 'utf8')
  console.log(`Wrote ${TARGET}`)
}
