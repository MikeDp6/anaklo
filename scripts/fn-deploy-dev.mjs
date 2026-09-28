// `npm run fn:deploy:dev`: deploys every Edge Function to the REMOTE dev project (ADR-0004
// order: migration → Edge Functions → frontend). Refuses to run unless the linked project is
// exactly SUPABASE_DEV_PROJECT_REF (like db-reset-dev.mjs), and passes that ref explicitly.
// Runs `fn:check` first. verify_jwt and the import map come from supabase/config.toml.
// Secrets (PROXY_SECRET, ONESIGNAL_*) are set separately by `npm run secrets:dev`.
//
//   npm run fn:deploy:dev                 check, then deploy (Docker bundling)
//   npm run fn:deploy:dev -- --use-api    bundle on Supabase's side (no Docker needed)
//   npm run fn:deploy:dev -- --dry-run    guard and fn:check only, deploys nothing
//
// Unknown arguments are refused before anything runs, so `--help` never deploys.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  REPO_ROOT,
  UsageError,
  assertLinkedToDev,
  readLocalEnv,
  requireDevProjectRef,
  runTool,
} from './lib/cli.mjs'

const HELP = `Usage: npm run fn:deploy:dev -- [--use-api] [--dry-run]

Guard (linked project = SUPABASE_DEV_PROJECT_REF) → npm run fn:check
→ supabase functions deploy --project-ref <dev ref> [--use-api]`

function readOptions() {
  try {
    return parseArgs({
      options: {
        'use-api': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

function main() {
  const options = readOptions()
  if (options.help) {
    console.log(HELP)
    return
  }

  const devRef = requireDevProjectRef([process.env, readLocalEnv()])
  assertLinkedToDev(devRef)

  const check = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'fn-check.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (check.status !== 0) throw new Error('fn:check failed; nothing was deployed.')

  const args = ['functions', 'deploy', '--project-ref', devRef]
  if (options['use-api']) args.push('--use-api')
  if (options['dry-run']) {
    console.log(`Dry run: would run supabase ${args.join(' ')}. Nothing was deployed.`)
    return
  }

  console.log(`Deploying the Edge Functions to the DEV project (${devRef})…`)
  const result = runTool('supabase', args)
  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit code ${result.status ?? 'none'}`
    throw new Error(`supabase functions deploy failed (${reason}).`)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = error instanceof UsageError ? 2 : 1
}
