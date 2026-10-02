// invite-member: an owner adds a manager or staff member by email (step 1.7, contract
// docs/plans/contracts/1.7-security-members.md §3.2). Only this file touches Deno and supabase-js;
// the flow is the pure `_shared/invite-member-handler.ts` (ADR-0002 §3).
// verify_jwt = true (supabase/config.toml): the pro app calls it directly with the user's JWT
// (ADR-0008 §10), never through the /api proxy. The owner and the fresh code are checked by
// `can_manage_members`, called AS the user, before the service-role client is created.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { consoleLog, type Rpc } from '../_shared/booking-rpc.ts'
import { handleInviteMember } from '../_shared/invite-member-handler.ts'
import {
  callerPort,
  inviteAdminPort,
  MEMBER_FUNCTION_ENV_NAMES,
  parseMemberFunctionEnv,
  type InviteAdminPort,
  type MemberFunctionConfig,
  type MemberFunctionDeps,
} from '../_shared/member-functions.ts'

const log = consoleLog('invite-member')
const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** `.rpc()` only (never `.from()`). */
function rpcOf(client: SupabaseClient): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args)
    return { data: data as unknown, error }
  }
}

function buildDeps(config: MemberFunctionConfig): MemberFunctionDeps<InviteAdminPort> {
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
      return inviteAdminPort(client.auth.admin, rpcOf(client))
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

Deno.serve((req) => handleInviteMember(req, deps))
