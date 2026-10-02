// manage-factors: removes one of the caller's own verified authenticator devices (step 1.7,
// contract docs/plans/contracts/1.7-security-members.md §3.3). Only this file touches Deno and
// supabase-js; the flow is the pure `_shared/manage-factors-handler.ts` (ADR-0002 §3).
// verify_jwt = true (supabase/config.toml): the pro app calls it directly with the user's JWT
// (ADR-0008 §10), never through the /api proxy. `authorize_factor_change` is called AS the user
// (fresh code, own factor, not the last one) before the service-role client is created.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { consoleLog, type Rpc } from '../_shared/booking-rpc.ts'
import { handleManageFactors } from '../_shared/manage-factors-handler.ts'
import {
  callerPort,
  factorsAdminPort,
  MEMBER_FUNCTION_ENV_NAMES,
  parseMemberFunctionEnv,
  type FactorsAdminPort,
  type MemberFunctionConfig,
  type MemberFunctionDeps,
} from '../_shared/member-functions.ts'

const log = consoleLog('manage-factors')
const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** `.rpc()` only (never `.from()`). */
function rpcOf(client: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args)
    return { data: data as unknown, error }
  }
}

function buildDeps(config: MemberFunctionConfig): MemberFunctionDeps<FactorsAdminPort> {
  return {
    caller(jwt) {
      // Acts as the caller: every request carries their JWT, so RLS and the SQL checks apply.
      const client = createClient(config.url, config.anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: NO_SESSION,
      })
      return callerPort(client.auth, jwt, rpcOf(client))
    },
    createAdmin() {
      const client = createClient(config.url, config.serviceRoleKey, { auth: NO_SESSION })
      return factorsAdminPort(client.auth.admin)
    },
    log,
  }
}

// Read once at start-up: a missing value answers 500 not_configured on every request.
const env = parseMemberFunctionEnv(
  Object.fromEntries(MEMBER_FUNCTION_ENV_NAMES.map((name) => [name, Deno.env.get(name)])),
)
if (!env.ok) log('not_configured', { problems: env.problems })
const deps = env.ok ? buildDeps(env.config) : null

Deno.serve((req) => handleManageFactors(req, deps))
