// manage: the manage link /m/<token> of the booking page (step 1.3, contract
// docs/plans/contracts/1.3-public-booking.md §5). Only this file touches Deno and supabase-js;
// everything else is the pure `_shared/manage-handler.ts` (ADR-0002 §3).
// verify_jwt = false (supabase/config.toml): reached only through the /api proxy, which sends
// the publishable key, not a user JWT; the proxy secret is checked in code instead.
import { createClient } from '@supabase/supabase-js'
import { consoleLog, type Rpc } from '../_shared/booking-rpc.ts'
import { BOOKING_ENV_NAMES, buildBookingRuntime } from '../_shared/booking-runtime.ts'
import { handleManage } from '../_shared/manage-handler.ts'

/** The service-role client, used only through `.rpc()` (never `.from()`). */
function createRpc(supabaseUrl: string, serviceRoleKey: string): Rpc {
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args)
    return { data: data as unknown, error }
  }
}

// Read once at start-up: an invalid configuration answers 500 not_configured on every request.
const env = Object.fromEntries(BOOKING_ENV_NAMES.map((name) => [name, Deno.env.get(name)]))
const runtime = buildBookingRuntime(env, { createRpc, log: consoleLog('manage') })

Deno.serve((req) => handleManage(req, runtime))
