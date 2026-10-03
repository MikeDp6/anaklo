// dispatch: the dispatcher of messages_log (step 1.5, contract
// docs/plans/contracts/1.5-messaging.md §3.1) and, since 1.9, the reaction to the authenticator
// device changes the detector found (contract docs/plans/contracts/1.9-health-detection.md §3.2).
// Only this file touches Deno and supabase-js; everything else is the pure
// `_shared/dispatch-handler.ts` and `_shared/security-handler.ts` (ADR-0002 §3).
// verify_jwt = false (supabase/config.toml): called only by the database through pg_net (the
// nudge after a staff action or a detection, the 5′ sweep) with the shared secret header, which
// is checked in code. NOT on the /api proxy's allow-list.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { consoleLog, type Rpc } from '../_shared/booking-rpc.ts'
import { handleDispatch } from '../_shared/dispatch-handler.ts'
import { buildDispatchRuntime, DISPATCH_ENV_NAMES } from '../_shared/dispatch-runtime.ts'
import { factorsAdminPort, type FactorsAdminPort } from '../_shared/member-functions.ts'

// One service-role client per process, shared by `rpc` and the Auth admin port.
let client: SupabaseClient | undefined
function serviceClient(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  client ??= createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return client
}

/** The service-role client, used only through `.rpc()` (never `.from()`). */
function createRpc(supabaseUrl: string, serviceRoleKey: string): Rpc {
  const supabase = serviceClient(supabaseUrl, serviceRoleKey)
  return async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args)
    return { data: data as unknown, error }
  }
}

/** `auth.admin.mfa.deleteFactor` of the same client (1.9: an unauthorized added factor). */
function createFactors(supabaseUrl: string, serviceRoleKey: string): FactorsAdminPort {
  return factorsAdminPort(serviceClient(supabaseUrl, serviceRoleKey).auth.admin)
}

// Read once at start-up: an invalid configuration answers 500 not_configured on every request.
const env = Object.fromEntries(DISPATCH_ENV_NAMES.map((name) => [name, Deno.env.get(name)]))
const runtime = buildDispatchRuntime(env, {
  createRpc,
  createFactors,
  log: consoleLog('dispatch'),
})

Deno.serve((req) => handleDispatch(req, runtime))
