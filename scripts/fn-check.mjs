// `npm run fn:check` (and CI): type-checks and lints the Edge Functions with the pinned `deno`
// devDependency (ADR-0002 §4). Every supabase/functions/<name>/index.ts is an entrypoint; the
// pure _shared modules are also checked on their own, so they stay valid Deno as well as Vite.
// It also checks that every function has its [functions.<name>] section in config.toml, with an
// explicit verify_jwt and the shared import map (the CLI does not find functions/deno.json alone).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const FUNCTIONS_DIR = join('supabase', 'functions')
const SHARED_DIR = join(FUNCTIONS_DIR, '_shared')
const DENO_CONFIG = join(FUNCTIONS_DIR, 'deno.json')
const SUPABASE_CONFIG = join('supabase', 'config.toml')
const IMPORT_MAP = './functions/deno.json'
const denoBin = createRequire(import.meta.url).resolve('deno/bin.cjs')

/** @type {string[]} */
const problems = []

const functionNames = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !/^[_.]/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

/** @type {string[]} */
const entrypoints = []
for (const name of functionNames) {
  const entrypoint = join(FUNCTIONS_DIR, name, 'index.ts')
  if (existsSync(entrypoint)) entrypoints.push(entrypoint)
  else problems.push(`${join(FUNCTIONS_DIR, name)} has no index.ts`)
}

const sharedModules = readdirSync(SHARED_DIR)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort()
  .map((file) => join(SHARED_DIR, file))

/**
 * The keys of every `[functions.<name>]` section. A minimal reader: enough for `key = value`
 * lines, which is all these sections contain.
 * @param {string} toml
 * @returns {Map<string, Map<string, string>>}
 */
function functionSections(toml) {
  /** @type {Map<string, Map<string, string>>} */
  const sections = new Map()
  /** @type {Map<string, string> | undefined} */
  let current
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header?.[1] !== undefined) {
      const name = /^functions\.("?)([\w-]+)\1$/.exec(header[1].trim())?.[2]
      current = name === undefined ? undefined : new Map()
      if (name !== undefined && current !== undefined) sections.set(name, current)
      continue
    }
    const pair = /^([\w-]+)\s*=\s*(.+)$/.exec(line)
    if (current !== undefined && pair?.[1] !== undefined && pair[2] !== undefined) {
      current.set(pair[1], pair[2].trim().replace(/^"(.*)"$/, '$1'))
    }
  }
  return sections
}

const sections = functionSections(readFileSync(SUPABASE_CONFIG, 'utf8'))
for (const name of functionNames) {
  const section = sections.get(name)
  if (section === undefined) {
    problems.push(`${SUPABASE_CONFIG} has no [functions.${name}] section`)
    continue
  }
  if (!['true', 'false'].includes(section.get('verify_jwt') ?? '')) {
    problems.push(`[functions.${name}] needs an explicit verify_jwt = true | false`)
  }
  if (section.get('import_map') !== IMPORT_MAP) {
    problems.push(`[functions.${name}] needs import_map = "${IMPORT_MAP}"`)
  }
}
for (const name of sections.keys()) {
  if (!functionNames.includes(name)) {
    problems.push(`[functions.${name}] in ${SUPABASE_CONFIG} has no ${join(FUNCTIONS_DIR, name)}`)
  }
}

/** @param {string[]} args */
function deno(args) {
  console.log(`> deno ${args.join(' ')}`)
  const result = spawnSync(process.execPath, [denoBin, ...args], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  return result.status === 0
}

let ok = problems.length === 0
for (const problem of problems) console.error(`fn:check: ${problem}`)
ok = deno(['check', '--config', DENO_CONFIG, ...entrypoints, ...sharedModules]) && ok
ok = deno(['lint', '--config', DENO_CONFIG, FUNCTIONS_DIR]) && ok

if (!ok) {
  console.error('fn:check failed.')
  process.exit(1)
}
console.log(`fn:check passed (${entrypoints.length} functions, ${sharedModules.length} shared).`)
