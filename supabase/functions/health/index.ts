// health: proves that the functions are deployed, that the proxy secret matches and where they
// run (ADR-0008 §3), and since 1.9 that the background jobs are alive (contract
// docs/plans/contracts/1.9-health-detection.md §3.1): 503 when a job or a security event is stale.
// verify_jwt = false (supabase/config.toml): the `/api` proxy sends the publishable key, not a
// user JWT; the proxy secret is checked in code. Only this file touches Deno and supabase-js; the
// logic is the pure `_shared/health-handler.ts` (ADR-0002 §3).
import { createClient } from '@supabase/supabase-js'
import { consoleLog } from '../_shared/booking-rpc.ts'
import { configValue } from '../_shared/booking-config.ts'
import { handleHealth, parseRegion, type HealthRpc } from '../_shared/health-handler.ts'

const log = consoleLog('health')

/** The service-role client, used only through `.rpc('health')`. */
function healthRpc(): HealthRpc | null {
  const supabaseUrl = configValue(Deno.env.get('SUPABASE_URL'))
  const serviceRoleKey = configValue(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  if (supabaseUrl === null || serviceRoleKey === null) {
    log('not_configured', {
      problems: [
        ...(supabaseUrl === null ? ['SUPABASE_URL: missing'] : []),
        ...(serviceRoleKey === null ? ['SUPABASE_SERVICE_ROLE_KEY: missing'] : []),
      ],
    })
    return null
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return async (signal) => {
    const { data, error } = await supabase.rpc('health').abortSignal(signal)
    return { data: data as unknown, error }
  }
}

// Read once at start-up.
const runtime = {
  proxySecret: Deno.env.get('PROXY_SECRET'),
  rpc: healthRpc(),
  region: parseRegion(Deno.env.get('SB_REGION') ?? Deno.env.get('DENO_REGION')),
  log,
}

Deno.serve((req) => handleHealth(req, runtime))
