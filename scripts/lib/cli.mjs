// Shared plumbing for the Nous operator scripts (provisioning, deploy, secrets): repository
// paths, env files kept OUTSIDE the repository, the dev-project guard and child processes that
// run without a shell (nothing is quoted or interpolated by cmd.exe, values never reach argv).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Supabase project refs: 20 lowercase letters or digits; anything else never reaches a command. */
export const PROJECT_REF = /^[a-z0-9]{20}$/

/** A mistake in how a script was called (exit code 2), as opposed to a failed operation. */
export class UsageError extends Error {}

/** @param {string} target */
function canonical(target) {
  const resolved = path.resolve(target)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/**
 * True when `target` is `dir` itself or anything below it. Symlinks and junctions are resolved
 * first; on Windows the comparison is case-insensitive (path.win32.relative).
 * @param {string} target
 * @param {string} dir
 */
export function isInside(target, dir) {
  const relative = path.relative(canonical(dir), canonical(target))
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * Parses a dotenv file without touching process.env.
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function readEnvFile(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  /** @type {Record<string, string>} */
  const values = {}
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (typeof value === 'string') values[name] = value
  }
  return values
}

/**
 * Reads an env file that may hold secrets. Refuses any file inside the repository: secrets live
 * in the password manager or in a file outside the repo, never next to the code (CLAUDE.md > Git).
 * @param {string | undefined} file
 * @returns {Record<string, string>}
 */
export function readSecretEnvFile(file) {
  if (file === undefined) return {}
  if (isInside(file, REPO_ROOT)) {
    throw new UsageError(`--env-file must be outside the repository (got ${path.resolve(file)}).`)
  }
  if (!existsSync(file)) throw new UsageError(`--env-file not found: ${path.resolve(file)}`)
  return readEnvFile(file)
}

/**
 * The repository's .env.local, for NON-secret values only (project ref, publishable key).
 * @returns {Record<string, string>}
 */
export function readLocalEnv() {
  const file = path.join(REPO_ROOT, '.env.local')
  return existsSync(file) ? readEnvFile(file) : {}
}

/**
 * First non-empty value among the sources, in order.
 * @param {string} name
 * @param {ReadonlyArray<Record<string, string | undefined>>} sources
 */
export function pick(name, sources) {
  for (const source of sources) {
    const value = source[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** The project `supabase link` points at (read locally, no network). */
export function linkedProjectRef() {
  const file = path.join(REPO_ROOT, 'supabase', '.temp', 'project-ref')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
}

/**
 * The dev project ref, validated. Throws a UsageError when it is missing or malformed.
 * @param {ReadonlyArray<Record<string, string | undefined>>} sources
 */
export function requireDevProjectRef(sources) {
  const ref = pick('SUPABASE_DEV_PROJECT_REF', sources)
  if (!ref) throw new UsageError('Set SUPABASE_DEV_PROJECT_REF (in .env.local or the environment).')
  if (!PROJECT_REF.test(ref)) {
    throw new UsageError(`SUPABASE_DEV_PROJECT_REF is not a project ref: "${ref}".`)
  }
  return ref
}

/**
 * Throws unless `supabase link` points at the dev project (same guard as db:reset:dev).
 * @param {string} devRef
 */
export function assertLinkedToDev(devRef) {
  const linked = linkedProjectRef()
  if (linked !== devRef) {
    throw new UsageError(
      `Linked project is "${linked || 'none'}", expected the dev project "${devRef}". ` +
        `Run: npx supabase link --project-ref ${devRef}`,
    )
  }
}

/**
 * Credentials of the CLIs themselves (supabase, wrangler). Taken from --env-file into the child
 * processes' environment; never deployed, never set as secrets.
 */
export const TOOL_TOKENS = /** @type {const} */ ([
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
])

/**
 * This process's environment plus the CLI tokens found in the env file.
 * @param {Record<string, string>} envFile
 * @returns {NodeJS.ProcessEnv}
 */
export function withToolTokens(envFile) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env }
  for (const name of TOOL_TOKENS) {
    if (envFile[name]) env[name] = envFile[name]
  }
  return env
}

/** @typedef {'supabase' | 'wrangler'} Tool */

/** @type {Record<Tool, string>} */
const TOOL_ENTRY = {
  supabase: 'node_modules/supabase/dist/supabase.js',
  wrangler: 'node_modules/wrangler/bin/wrangler.js',
}

/**
 * @typedef {object} RunOptions
 * @property {NodeJS.ProcessEnv} [env] environment of the child (default: this process's)
 * @property {string} [input] written to the child's stdin (e.g. a secret value); never logged
 * @property {boolean} [capture] return stdout instead of printing it
 */

/**
 * Runs a pinned CLI from node_modules with node: no shell, no npx, arguments passed as an array.
 * @param {Tool} tool
 * @param {readonly string[]} args
 * @param {RunOptions} [options]
 */
export function runTool(tool, args, options = {}) {
  const entry = path.join(REPO_ROOT, TOOL_ENTRY[tool])
  if (!existsSync(entry)) throw new Error(`${tool} is not installed (${entry}). Run: npm ci`)
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: [
      options.input === undefined ? 'inherit' : 'pipe',
      options.capture ? 'pipe' : 'inherit',
      options.capture ? 'pipe' : 'inherit',
    ],
  })
}

/**
 * Runs an npm script of this repository. Uses npm's own JS entry when started through npm (no
 * shell); otherwise falls back to a constant command line.
 * @param {string} script a name from package.json (constant, never user input)
 * @param {NodeJS.ProcessEnv} env
 */
export function runNpmScript(script, env) {
  const npmCli = process.env.npm_execpath
  const options = /** @type {const} */ ({ cwd: REPO_ROOT, env, stdio: 'inherit' })
  if (npmCli && /\.c?js$/.test(npmCli)) {
    return spawnSync(process.execPath, [npmCli, 'run', script], options)
  }
  return spawnSync(`npm run ${script}`, { ...options, shell: true })
}

/**
 * Local stack address and keys, from `supabase status` (the stack must be running). Used by
 * `provision:local` and the database integration tests (`npm run test:race`).
 * @returns {{ apiUrl: string, publishableKey: string, secretKey: string }}
 */
export function localSupabase() {
  const result = runTool('supabase', ['status', '-o', 'json'], { capture: true })
  const stdout = result.stdout ?? ''
  const json = stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)
  /** @type {Record<string, unknown>} */
  let status = {}
  try {
    status = JSON.parse(json)
  } catch {
    // handled below
  }
  const apiUrl = typeof status.API_URL === 'string' ? status.API_URL : ''
  const publishableKey = typeof status.PUBLISHABLE_KEY === 'string' ? status.PUBLISHABLE_KEY : ''
  const secretKey = typeof status.SECRET_KEY === 'string' ? status.SECRET_KEY : ''
  if (result.status !== 0 || !apiUrl || !publishableKey || !secretKey) {
    throw new Error('Could not read the local stack from `supabase status`. Run: npm run db:start')
  }
  const host = new URL(apiUrl).hostname
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`supabase status reports a non-local API URL (${apiUrl}); refusing.`)
  }
  return { apiUrl, publishableKey, secretKey }
}
