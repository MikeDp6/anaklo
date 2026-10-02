// Provisions one business (demo or pilot) from a JSON file kept OUTSIDE the repository, until the
// onboarding of Phase 5 (ADR-0009 §8, plan 1.1). Uses the secret key, so it bypasses RLS and the
// aal2 policies: a Nous tool only. Idempotent by slug; never writes appointments.
//
//   npm run provision:local                      synthetic example → local stack
//   npm run provision:dev -- --file <path>       your file → SUPABASE_DEV_PROJECT_REF
//   npm run provision:dev -- --file <path> --validate    check the file only, no connection
//   npm run provision:dev -- --file <path> --reason "<why>" --ticket <id>
//                                                a change to an EXISTING business (step 1.7)
//
// The secret key comes from the environment (SUPABASE_SECRET_KEY) or from --env-file <path
// outside the repo>; never from .env.local or any file in the repository.
// From 1.7 (contract §5.2): a slug that is a former address of a business is refused, and any
// change to an existing business first writes an audit row (record_support_action
// 'provision_update', `[ticket] reason`); without --reason/--ticket it is refused before any write.
// With --local they default to "local provisioning" / LOCAL.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { REPO_ROOT, UsageError, isInside, resolveSupabaseTarget } from './lib/cli.mjs'
import { ProvisionConflict, formatSummary, provisionBusiness } from './lib/provision-apply.mjs'
import { parseProvisionArgs } from './lib/provision-args.mjs'
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
  --reason "<text>"     why an EXISTING business changes (3–400 characters); required with
  --ticket <id>         the support ticket when anything changes, written to audit_log first.
                        With --local they default to "local provisioning" / LOCAL.
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

async function main() {
  const options = parseProvisionArgs(process.argv.slice(2))
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

  const target = resolveSupabaseTarget(options)
  console.log(`Provisioning "${desired.business.slug}" on ${target.label}`)
  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const summary = await provisionBusiness(db, desired, options.support)
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
