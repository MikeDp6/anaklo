// Rebuilds the REMOTE dev database from the migrations (ADR-0004), for the period before any
// real data exists, when an already-pushed migration was edited. `db push` alone would skip it.
// Refuses to run unless the linked project is exactly SUPABASE_DEV_PROJECT_REF.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** @param {string} file */
function readEnvFile(file) {
  if (!existsSync(file)) return {}
  /** @type {Record<string, string>} */
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match?.[1]) values[match[1]] = (match[2] ?? '').replace(/^"|"$/g, '')
  }
  return values
}

const devRef =
  process.env.SUPABASE_DEV_PROJECT_REF || readEnvFile('.env.local').SUPABASE_DEV_PROJECT_REF
const linkedRefFile = 'supabase/.temp/project-ref'
const linkedRef = existsSync(linkedRefFile) ? readFileSync(linkedRefFile, 'utf8').trim() : ''

if (!devRef) {
  console.error('Set SUPABASE_DEV_PROJECT_REF in .env.local first.')
  process.exit(1)
}
if (linkedRef !== devRef) {
  console.error(`Linked project is "${linkedRef || 'none'}", expected the dev project "${devRef}".`)
  console.error(`Run: npx supabase link --project-ref ${devRef}`)
  process.exit(1)
}

console.log(`Resetting the remote DEV database (${devRef}) from supabase/migrations + seed.sql…`)
const result = spawnSync('npx supabase db reset --linked', {
  stdio: 'inherit',
  shell: true,
})
process.exit(result.status ?? 1)
