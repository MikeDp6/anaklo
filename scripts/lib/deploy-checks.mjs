// Checks shared by deploy-dev.mjs and secrets-dev.mjs: which Supabase project the Worker config
// points at, and the build output (no source maps, no local stack address). Pure or local-file
// only; Vitest: deploy-checks.test.mjs.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Copies `text` outside string literals through `outside` (strings are kept verbatim).
 * @param {string} text
 * @param {(text: string, i: number) => { out: string, next: number }} outside
 */
function mapOutsideStrings(text, outside) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
      out += text.slice(start, i)
    } else {
      const step = outside(text, i)
      out += step.out
      i = step.next
    }
  }
  return out
}

/**
 * Parses JSON with comments and trailing commas (wrangler.jsonc). Comment markers inside strings
 * (e.g. "https://…") are kept. Comments go first, so a comma followed by a comment and then a
 * closing bracket is still a trailing comma.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  const withoutComments = mapOutsideStrings(text, (source, i) => {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      return { out: '', next: end === -1 ? source.length : end }
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      return { out: ' ', next: end === -1 ? source.length : end + 2 }
    }
    return { out: source[i] ?? '', next: i + 1 }
  })
  const withoutTrailingCommas = mapOutsideStrings(withoutComments, (source, i) => {
    const trailing = source[i] === ',' && /^\s*[}\]]/.test(source.slice(i + 1))
    return { out: trailing ? '' : (source[i] ?? ''), next: i + 1 }
  })
  return JSON.parse(withoutTrailingCommas)
}

/**
 * The Supabase URL the Worker proxies to (`vars.SUPABASE_URL` in wrangler.jsonc).
 * @param {string} configText
 * @returns {string | undefined}
 */
export function workerSupabaseUrl(configText) {
  const config = parseJsonc(configText)
  if (typeof config !== 'object' || config === null || !('vars' in config)) return undefined
  const vars = config.vars
  if (typeof vars !== 'object' || vars === null || !('SUPABASE_URL' in vars)) return undefined
  return typeof vars.SUPABASE_URL === 'string' ? vars.SUPABASE_URL : undefined
}

/**
 * Problem message when the Worker config does not point at the dev project, else null.
 * @param {string} configFile
 * @param {string} devRef
 * @returns {string | null}
 */
export function workerTargetProblem(configFile, devRef) {
  let url
  try {
    url = workerSupabaseUrl(readFileSync(configFile, 'utf8'))
  } catch (error) {
    return `Cannot read ${configFile}: ${error instanceof Error ? error.message : String(error)}`
  }
  const expected = `https://${devRef}.supabase.co`
  if (url?.replace(/\/+$/, '') !== expected) {
    return `${configFile}: vars.SUPABASE_URL is "${url ?? 'missing'}", expected ${expected}.`
  }
  return null
}

/**
 * Every file below `dir` (paths relative to it, with "/").
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  /** @type {string[]} */
  const files = []
  /** @param {string} current */
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(path.relative(dir, full).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return files
}

/**
 * Deletes every *.map below `dir` and reports what is left (must be nothing): maps are for Sentry
 * only and must never be served (ADR-0008 §7).
 * @param {string} dir
 */
export function removeSourceMaps(dir) {
  const maps = listFiles(dir).filter((file) => file.endsWith('.map'))
  for (const file of maps) rmSync(path.join(dir, file), { force: true })
  return { removed: maps, remaining: listFiles(dir).filter((file) => file.endsWith('.map')) }
}

const LOCAL_STACK = /(127\.0\.0\.1|localhost|\[::1\]):54321/

/**
 * Problems in a dev build: bundles that still point at the local stack, or none that points at
 * the dev project (the build must have used the dev VITE_SUPABASE_URL).
 * @param {string} dir the build output
 * @param {string} devUrl https://<ref>.supabase.co
 * @returns {string[]}
 */
export function buildTargetProblems(dir, devUrl) {
  const bundles = listFiles(dir).filter((file) => /\.(js|html)$/.test(file))
  const problems = bundles
    .filter((file) => LOCAL_STACK.test(readFileSync(path.join(dir, file), 'utf8')))
    .map((file) => `${file} points at the local Supabase stack.`)
  const mentionsDev = bundles.some((file) =>
    readFileSync(path.join(dir, file), 'utf8').includes(devUrl),
  )
  if (!mentionsDev) problems.push(`No bundle references ${devUrl}.`)
  return problems
}
