// The Nous reset of a user's authenticator devices, after the identity check of the runbook
// docs/runbooks/mfa-reset.md (ADR-0009 §17, contract 1.7 §5.1). Uses the secret key: a Nous tool
// only, never exposed anywhere.
//
//   npm run mfa-reset -- --email <e> --reason "<why>" --ticket <id>            dry run, dev project
//   npm run mfa-reset -- --email <e> --reason "<why>" --ticket <id> --yes      the reset, dev
//   node scripts/mfa-reset.mjs --local --email <e> --reason "<why>" --ticket <id> [--yes]
//   … --prod --project-ref <ref> --env-file <path outside the repo>            production
//
// The DEFAULT target is the remote dev project: rehearse with --local. Without --yes nothing is
// written. With --yes: grants and audit rows (record_support_action, which also lifts an
// enrolment block and ends every session in the same transaction, and refuses while an
// unauthorized removal of the user awaits the detector: rerun in a few minutes), then every factor
// of the user (auth.admin.mfa.deleteFactor), then every session again (revoke_user_sessions);
// then it prints the summary (with the enrolment block line)
// and the emails of the runbook, filled in. Never reads or prints a TOTP secret.
// A user who is owner or manager nowhere (a blocked manager demoted to staff, or removed) is not
// refused by the script (contract 1.9b §7 item 17): with --yes, record_support_action lifts the
// block, or refuses (22023, nothing written) when there is none; no email template applies.
// The secret key comes from the environment (SUPABASE_SECRET_KEY) or --env-file <path outside
// the repo>; never from .env.local or any file in the repository.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { REPO_ROOT, UsageError, resolveSupabaseTarget } from './lib/cli.mjs'
import {
  extractEmailTemplates,
  parseMfaResetArgs,
  runMfaReset,
  supportPorts,
} from './lib/mfa-reset.mjs'

const RUNBOOK = path.join(REPO_ROOT, 'docs', 'runbooks', 'mfa-reset.md')

const HELP = `Usage: node scripts/mfa-reset.mjs --email <address> --reason "<text>" --ticket <id> [options]

Follow docs/runbooks/mfa-reset.md: never without the identity check.

  --email <address>     the account whose authenticator devices are reset
  --reason "<text>"     why (3–400 characters), written to audit_log
  --ticket <id>         the support ticket (letters, digits, . _ # / -; up to 40)
  --yes                 do it; without --yes it is a dry run that writes nothing
  --local               the local stack (URL and secret key from \`supabase status\`)
  --project-ref <ref>   remote project (default: SUPABASE_DEV_PROJECT_REF); any other project
                        is refused unless --prod is given
  --prod                allow a project other than the dev one (requires --project-ref)
  --env-file <path>     env file OUTSIDE the repository with SUPABASE_SECRET_KEY
  --help`

async function main() {
  const options = parseMfaResetArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  // The texts are checked before connecting: a broken runbook stops the reset before it starts.
  const templates = extractEmailTemplates(readFileSync(RUNBOOK, 'utf8'))
  const target = resolveSupabaseTarget(options)
  console.log(`mfa-reset on ${target.label}${options.yes ? '' : ' (dry run)'}`)
  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  process.exitCode = await runMfaReset(supportPorts(db), {
    email: options.email,
    reason: options.reason,
    ticket: options.ticket,
    yes: options.yes,
    now: new Date(),
    templates,
    print: (line) => console.log(line),
  })
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(error.message)
    console.error('Run with --help for usage.')
    process.exitCode = 2
  } else {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
})
