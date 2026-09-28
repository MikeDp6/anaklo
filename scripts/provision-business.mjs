// Provisions one business (demo or pilot) from a JSON file kept OUTSIDE the repository, until the
// onboarding of Phase 5 (ADR-0009 §8, plan 1.1). Uses the secret key, so it bypasses RLS and the
// aal2 policies: a Nous tool only. Idempotent by slug; never writes appointments.
//
//   npm run provision:local                      synthetic example → local stack
//   npm run provision:dev -- --file <path>       your file → SUPABASE_DEV_PROJECT_REF
//   npm run provision:dev -- --file <path> --validate    check the file only, no connection
//
// The secret key comes from the environment (SUPABASE_SECRET_KEY) or from --env-file <path
// outside the repo>; never from .env.local or any file in the repository.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import {
  PROJECT_REF,
  REPO_ROOT,
  UsageError,
  isInside,
  localSupabase,
  pick,
  readLocalEnv,
  readSecretEnvFile,
  requireDevProjectRef,
} from './lib/cli.mjs'
import { ProvisionConflict, formatSummary, provisionBusiness } from './lib/provision-apply.mjs'
import { parseProvisionFile } from './lib/provision-schema.mjs'

const EXAMPLE_FILE = path.join(REPO_ROOT, 'supabase', 'provision', 'demo-barber.example.json')
const DEFAULT_FILE = path.join(homedir(), 'anaklo-private', 'provision.json')

const HELP = `Usage: node scripts/provision-business.mjs [options]

  --file <path>         provisioning JSON (default: ${DEFAULT_FILE};
                        with --local: the synthetic example). Inside the repository only
                        *.example.json files are accepted.
  --local               the local stack (URL and secret key from \`supabase status\`)
  --project-ref <ref>   remote project (default: SUPABASE_DEV_PROJECT_REF); any other project
                        is refused unless --prod is given
  --prod                allow a project other than the dev one (requires --project-ref)
  --env-file <path>     env file OUTSIDE the repository with SUPABASE_SECRET_KEY
  --validate            only validate the file; connect to nothing
  --help`

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  const resolved = path.resolve(file)
  if (isInside(resolved, REPO_ROOT) && !resolved.endsWith('.example.json')) {
    throw new UsageError(
      `Provisioning files live outside the repository (got ${resolved}). ` +
        'Only the synthetic *.example.json is committed.',
    )
  }
  let text
  try {
    text = readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    throw new UsageError(`Cannot read ${resolved}. Pass --file <path>.`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${resolved} is not valid JSON: ${String(error)}`)
  }
}

/**
 * Where to write and with which key, after the dev-project guard.
 * @param {{ local: boolean, prod: boolean, 'project-ref'?: string, 'env-file'?: string }} options
 */
function resolveTarget(options) {
  if (options.local) {
    if (options.prod || options['project-ref'] || options['env-file']) {
      throw new UsageError('--local cannot be combined with --prod, --project-ref or --env-file.')
    }
    const { apiUrl, secretKey } = localSupabase()
    return { label: `local (${apiUrl})`, url: apiUrl, key: secretKey }
  }

  const envFile = readSecretEnvFile(options['env-file'])
  const devRef = requireDevProjectRef([process.env, envFile, readLocalEnv()])
  const ref = options['project-ref'] ?? devRef
  if (!PROJECT_REF.test(ref)) throw new UsageError(`Not a project ref: "${ref}".`)
  if (options.prod && !options['project-ref']) {
    throw new UsageError('--prod requires an explicit --project-ref.')
  }
  if (ref !== devRef && !options.prod) {
    throw new UsageError(
      `Refusing project "${ref}": only the dev project "${devRef}" is allowed without --prod.`,
    )
  }
  // Secret: never from .env.local or anything inside the repository.
  const key = pick('SUPABASE_SECRET_KEY', [envFile, process.env])
  if (!key) {
    throw new UsageError(
      'Set SUPABASE_SECRET_KEY in the environment or pass --env-file <path outside the repo>.',
    )
  }
  if (key.startsWith('sb_publishable_')) {
    throw new UsageError('SUPABASE_SECRET_KEY holds a publishable key; use the secret key.')
  }
  const label = ref === devRef ? `dev project ${ref}` : `PRODUCTION project ${ref}`
  return { label, url: `https://${ref}.supabase.co`, key }
}

function readOptions() {
  try {
    return parseArgs({
      options: {
        file: { type: 'string' },
        local: { type: 'boolean', default: false },
        prod: { type: 'boolean', default: false },
        'project-ref': { type: 'string' },
        'env-file': { type: 'string' },
        validate: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  const options = readOptions()
  if (options.help) {
    console.log(HELP)
    return
  }

  const file = options.file ?? (options.local ? EXAMPLE_FILE : DEFAULT_FILE)
  const parsed = parseProvisionFile(readJson(file))
  if (!parsed.ok) {
    console.error(`${path.resolve(file)} is not valid:`)
    for (const line of parsed.errors) console.error(`  - ${line}`)
    process.exitCode = 1
    return
  }
  const { desired } = parsed
  if (options.validate) {
    console.log(
      `${path.resolve(file)} is valid: "${desired.business.slug}", ${desired.staff.length} staff, ` +
        `${desired.services.length} services, ${desired.members.length} logins.`,
    )
    return
  }

  const target = resolveTarget(options)
  console.log(`Provisioning "${desired.business.slug}" on ${target.label}`)
  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const summary = await provisionBusiness(db, desired)
  for (const line of formatSummary(summary)) console.log(line)
}

main().catch((error) => {
  if (error instanceof ProvisionConflict) {
    console.error('Refused, nothing was written:')
    for (const line of error.problems) console.error(`  - ${line}`)
    process.exitCode = 1
  } else if (error instanceof UsageError) {
    console.error(error.message)
    console.error('Run with --help for usage.')
    process.exitCode = 2
  } else {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
})
