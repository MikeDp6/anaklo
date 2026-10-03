// `npm run secrets:dev`: sets the dev secrets, idempotently (plan 1.1, ADR-0008 §1):
// - Edge Functions: `supabase secrets set --project-ref <dev ref> --env-file <temp file>`
// - Worker: `wrangler secret put <NAME> --config edge/wrangler.jsonc`, value on stdin
// - PROXY_SECRET gets the SAME value in both
// - Vault: one DO block (create or update by name) through `supabase db query --linked --file
//   <temp file>`, only when `supabase link` points at the dev project; its output is redacted
// Values come from the environment or from --env-file <path OUTSIDE the repo> (the file wins).
// They are never printed, never put on a command line and never written inside the repository:
// the functions' dotenv goes to a private temp directory and is deleted right after.
//
//   npm run secrets:dev -- --env-file C:\Users\<you>\anaklo-private\dev.env
//   npm run secrets:dev -- --env-file <path> --dry-run     names and targets only, no calls
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  REPO_ROOT,
  UsageError,
  assertLinkedToDev,
  readEnvFile,
  readLocalEnv,
  readSecretEnvFile,
  requireDevProjectRef,
  runTool,
  withToolTokens,
} from './lib/cli.mjs'
import { workerTargetProblem } from './lib/deploy-checks.mjs'
import { planSecrets, redact, toDotenv, vaultUpsertSql } from './lib/secrets-plan.mjs'

const WRANGLER_CONFIG = 'edge/wrangler.jsonc'

const HELP = `Usage: npm run secrets:dev -- --env-file <path outside the repo> [--dry-run]

Sets PROXY_SECRET (functions + Worker), SUPABASE_PUBLISHABLE_KEY (Worker, from
SUPABASE_DEV_PUBLISHABLE_KEY), PUSH_PROVIDER (functions: fake | onesignal), DISPATCH_SECRET
(functions, and Vault dispatch_secret with the same value), DISPATCH_URL (Vault dispatch_url:
exactly https://<dev ref>.supabase.co/functions/v1/dispatch), when present
ONESIGNAL_APP_ID + ONESIGNAL_REST_API_KEY (functions; required with PUSH_PROVIDER=onesignal),
EMAIL_PROVIDER (functions: fake until 1.10) + SUPPORT_EMAIL (functions: the real Nous address),
and OTP_HMAC_KEY + PHONE_HMAC_KEY (Vault: otp_hmac_key, phone_hmac_key). Vault needs
supabase link to the dev project. CLI tokens in the file
(SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, …) are passed to the CLIs only. Values are never
printed.`

function readOptions() {
  try {
    return parseArgs({
      options: {
        'env-file': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

/** Local and example secrets: a dev secret must be different from both. */
function knownLocalValues() {
  const example = path.join(REPO_ROOT, '.env.example')
  const values = [readLocalEnv().PROXY_SECRET]
  try {
    values.push(readEnvFile(example).PROXY_SECRET)
  } catch {
    // no example file: nothing to compare with
  }
  return values.filter(
    /** @returns {value is string} */ (value) => typeof value === 'string' && value !== '',
  )
}

/**
 * @param {string} what
 * @param {{ status: number | null, error?: Error }} result
 */
function check(what, result) {
  if (result.status === 0) return
  const reason = result.error ? result.error.message : `exit code ${result.status ?? 'none'}`
  throw new Error(`${what} failed (${reason}). Rerun when fixed: setting a secret is idempotent.`)
}

function main() {
  const options = readOptions()
  if (options.help) {
    console.log(HELP)
    return
  }

  const envFile = readSecretEnvFile(options['env-file'])
  const devRef = requireDevProjectRef([process.env, envFile, readLocalEnv()])
  const workerProblem = workerTargetProblem(path.join(REPO_ROOT, WRANGLER_CONFIG), devRef)
  if (workerProblem) throw new UsageError(workerProblem)

  // .env.local may provide only the (public) dev publishable key; its secrets are local ones.
  const publicLocal = { SUPABASE_DEV_PUBLISHABLE_KEY: readLocalEnv().SUPABASE_DEV_PUBLISHABLE_KEY }
  const plan = planSecrets(
    { ...publicLocal, ...process.env, ...envFile },
    { knownLocalValues: knownLocalValues(), projectRef: devRef },
    Object.keys(envFile),
  )
  const names = (/** @type {Array<{ name: string }>} */ list) =>
    list.map((entry) => entry.name).join(', ') || '-'
  console.log(`Dev project ${devRef}, Worker config ${WRANGLER_CONFIG}`)
  console.log(`  Edge Functions: ${names(plan.functions)}`)
  console.log(`  Worker:         ${names(plan.worker)}`)
  console.log(`  Vault:          ${names(plan.vault)}`)
  if (plan.skipped.length > 0) console.log(`  Not set (no value): ${plan.skipped.join(', ')}`)
  if (plan.ignored.length > 0) console.log(`  In the file but unused: ${plan.ignored.join(', ')}`)
  if (plan.problems.length > 0) {
    throw new UsageError(`Nothing was set:\n  - ${plan.problems.join('\n  - ')}`)
  }
  // Vault goes through the linked project: refuse before anything is set if that is not dev.
  if (plan.vault.length > 0) assertLinkedToDev(devRef)
  if (options['dry-run']) {
    console.log('Dry run: nothing was set.')
    return
  }

  const env = withToolTokens(envFile)

  // Functions first; then the Worker with the same PROXY_SECRET. If the Worker step fails, the
  // two differ until a rerun (the proxy answers 403 meanwhile), so the script says so.
  if (plan.functions.length > 0) {
    const dir = mkdtempSync(path.join(tmpdir(), 'anaklo-secrets-'))
    const file = path.join(dir, 'functions.env')
    try {
      writeFileSync(file, toDotenv(plan.functions), { encoding: 'utf8', mode: 0o600 })
      console.log('\nEdge Function secrets (supabase secrets set)')
      check(
        'supabase secrets set',
        runTool('supabase', ['secrets', 'set', '--project-ref', devRef, '--env-file', file], {
          env,
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  for (const { name, value } of plan.worker) {
    console.log(`\nWorker secret ${name} (wrangler secret put)`)
    const result = runTool('wrangler', ['secret', 'put', name, '--config', WRANGLER_CONFIG], {
      env,
      input: value,
    })
    if (result.status !== 0) {
      throw new Error(
        `wrangler secret put ${name} failed (exit code ${result.status ?? 'none'}). ` +
          'The functions may already have the new PROXY_SECRET: rerun secrets:dev when fixed.',
      )
    }
  }
  if (plan.vault.length > 0) {
    const dir = mkdtempSync(path.join(tmpdir(), 'anaklo-secrets-'))
    const file = path.join(dir, 'vault.sql')
    try {
      writeFileSync(file, vaultUpsertSql(plan.vault), { encoding: 'utf8', mode: 0o600 })
      console.log('\nVault secrets (supabase db query --linked, create or update by name)')
      const result = runTool('supabase', ['db', 'query', '--linked', '--file', file], {
        env,
        capture: true,
      })
      if (result.status !== 0) {
        // An SQL error may quote the statement: print the output only with the values hidden.
        const values = plan.vault.map((entry) => entry.value)
        const output = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`, values).trim()
        if (output) console.error(output)
        check('supabase db query (Vault)', result)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  console.log(
    '\nDone. Nothing was printed; check with: supabase secrets list, wrangler secret list, ' +
      'and in SQL: select name, updated_at from vault.secrets.',
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = error instanceof UsageError ? 2 : 1
}
