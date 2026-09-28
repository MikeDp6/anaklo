// `npm run deploy:dev`: deploys to the dev environment in the ADR-0004 order (ADR-0008 §9):
// migrations → Edge Functions → frontend build → source maps deleted → Worker.
// - Refuses unless the linked project AND the Worker config point at SUPABASE_DEV_PROJECT_REF.
// - Idempotent: every step is (db push applies only new migrations; the rest redeploys the same).
// - Never touches the Auth settings: no `supabase config push`, ever (ADR-0009 §7).
// - Secrets are not set here: `npm run secrets:dev`.
//
//   npm run deploy:dev                        asks before pushing migrations
//   npm run deploy:dev -- --yes               no prompt from `supabase db push`
//   npm run deploy:dev -- --dry-run           checks and plan only, runs nothing
//   npm run deploy:dev -- --env-file <path>   file OUTSIDE the repo with tool tokens
//                                             (SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN, …)
//
// Build values (public by design): SUPABASE_DEV_PUBLISHABLE_KEY and, optionally,
// VITE_ONESIGNAL_APP_ID, from the environment, --env-file or .env.local. The Supabase URL of the
// build is derived from the dev ref, so .env.local's LOCAL values never reach the dev bundle.
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  REPO_ROOT,
  UsageError,
  assertLinkedToDev,
  pick,
  readLocalEnv,
  readSecretEnvFile,
  requireDevProjectRef,
  runNpmScript,
  runTool,
  withToolTokens,
} from './lib/cli.mjs'
import { buildTargetProblems, removeSourceMaps, workerTargetProblem } from './lib/deploy-checks.mjs'

const WRANGLER_CONFIG = 'edge/wrangler.jsonc'
const DIST = path.join(REPO_ROOT, 'dist')

const HELP = `Usage: npm run deploy:dev -- [--yes] [--dry-run] [--env-file <path outside the repo>]

Order: supabase db push → npm run fn:deploy:dev → npm run build (dev URL and key)
       → delete dist/**/*.map (fails if any remains) → wrangler deploy --config ${WRANGLER_CONFIG}`

function readOptions() {
  try {
    return parseArgs({
      options: {
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'env-file': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    }).values
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * @param {string} step
 * @param {{ status: number | null, error?: Error }} result
 */
function check(step, result) {
  if (result.status === 0) return
  const reason = result.error ? result.error.message : `exit code ${result.status ?? 'none'}`
  throw new Error(`${step} failed (${reason}). Fix it and rerun: every step is idempotent.`)
}

function main() {
  const options = readOptions()
  if (options.help) {
    console.log(HELP)
    return
  }

  // Guard: everything must point at the dev project before anything runs.
  const envFile = readSecretEnvFile(options['env-file'])
  const sources = [process.env, envFile, readLocalEnv()]
  const devRef = requireDevProjectRef(sources)
  assertLinkedToDev(devRef)
  const workerProblem = workerTargetProblem(path.join(REPO_ROOT, WRANGLER_CONFIG), devRef)
  if (workerProblem) throw new UsageError(workerProblem)
  const publishableKey = pick('SUPABASE_DEV_PUBLISHABLE_KEY', sources)
  if (!publishableKey?.startsWith('sb_publishable_')) {
    throw new UsageError(
      'Set SUPABASE_DEV_PUBLISHABLE_KEY (the dev project’s sb_publishable_ key; public, may live in .env.local).',
    )
  }
  const devUrl = `https://${devRef}.supabase.co`

  const toolEnv = withToolTokens(envFile)
  const oneSignalAppId = pick('VITE_ONESIGNAL_APP_ID', [process.env, envFile])
  /** @type {NodeJS.ProcessEnv} */
  const buildEnv = {
    ...toolEnv,
    // Existing environment variables win over Vite's .env files, so .env.local's local stack
    // address and key are overridden here.
    VITE_SUPABASE_URL: devUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    // Always set (empty hides the push test), so a LOCAL OneSignal app id in .env.local never
    // ends up in the dev bundle: OneSignal apps are bound to one origin.
    VITE_ONESIGNAL_APP_ID: oneSignalAppId ?? '',
  }

  const pushArgs = ['db', 'push', '--linked', ...(options.yes ? ['--yes'] : [])]
  console.log(`Deploying to the DEV project ${devRef} (${devUrl})`)
  if (options['dry-run']) {
    console.log(
      [
        `  1. supabase ${pushArgs.join(' ')}`,
        '  2. npm run fn:deploy:dev',
        `  3. npm run build   (VITE_SUPABASE_URL=${devUrl}, dev publishable key)`,
        '  4. delete dist/**/*.map, fail if any remains; check the bundle targets',
        `  5. wrangler deploy --config ${WRANGLER_CONFIG}`,
        'Dry run: nothing was run.',
      ].join('\n'),
    )
    return
  }

  console.log('\n1/5 Migrations (supabase db push)')
  check('supabase db push', runTool('supabase', pushArgs, { env: toolEnv }))

  console.log('\n2/5 Edge Functions (npm run fn:deploy:dev)')
  check('fn:deploy:dev', runNpmScript('fn:deploy:dev', toolEnv))

  console.log('\n3/5 Frontend build (npm run build)')
  check('npm run build', runNpmScript('build', buildEnv))

  console.log('\n4/5 Source maps and build checks')
  const { removed, remaining } = removeSourceMaps(DIST)
  console.log(`  deleted ${removed.length} source map(s)`)
  if (remaining.length > 0) {
    throw new Error(`Source maps are still in dist/: ${remaining.join(', ')}. Not deploying.`)
  }
  const problems = buildTargetProblems(DIST, devUrl)
  if (problems.length > 0)
    throw new Error(`The build is not a dev build:\n  ${problems.join('\n  ')}`)

  console.log(`\n5/5 Worker (wrangler deploy --config ${WRANGLER_CONFIG})`)
  check(
    'wrangler deploy',
    runTool('wrangler', ['deploy', '--config', WRANGLER_CONFIG], { env: toolEnv }),
  )
  console.log('\nDeployed. Smoke test: /api/functions/v1/health → 200 through the Worker.')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = error instanceof UsageError ? 2 : 1
}
