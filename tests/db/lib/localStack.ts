import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod/mini'
import { localSupabase } from '../../../scripts/lib/cli.mjs'
import type { Database } from '../../../src/shared/lib/database.types.ts'

/**
 * supabase-js against the LOCAL stack only. `localSupabase()` reads `supabase status` and refuses
 * any API URL that is not localhost, so these tests can never reach a remote project; no key is
 * stored in the repository.
 */
export type Db = SupabaseClient<Database>

type LocalStack = ReturnType<typeof localSupabase>

// In-memory sessions only: nothing is written to disk, nothing refreshes in the background.
const IN_MEMORY = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}

let stack: LocalStack | undefined

function localStack(): LocalStack {
  stack ??= localSupabase()
  return stack
}

/** service_role (secret key): Auth admin, and read-backs that must not depend on RLS. */
export function adminClient(): Db {
  const { apiUrl, secretKey } = localStack()
  return createClient<Database>(apiUrl, secretKey, IN_MEMORY)
}

/**
 * Signs a seed user in without any email: Auth admin mints the one-time code of a magic link
 * (`generateLink` sends nothing) and a publishable-key client redeems it with `verifyOtp`, the
 * same call the pro app makes with the 6-digit code (ADR-0009).
 *
 * Auth keeps one pending code per user, so do not run this while an e2e run signs the same user
 * in (CI runs them one after the other).
 */
export async function signInAs(email: string): Promise<Db> {
  const { apiUrl, publishableKey } = localStack()
  const link = await adminClient().auth.admin.generateLink({ type: 'magiclink', email })
  if (link.error) throw link.error

  const client = createClient<Database>(apiUrl, publishableKey, IN_MEMORY)
  const verified = await client.auth.verifyOtp({
    email,
    token: link.data.properties.email_otp,
    type: 'email',
  })
  if (verified.error) throw verified.error
  if (!verified.data.session) throw new Error(`no session for ${email}`)
  return client
}

/** Ends only this client's session (the default 'global' would sign the user out everywhere). */
export async function signOut(client: Db): Promise<void> {
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw error
}

/**
 * «Αποσύνδεση από όλες τις συσκευές» at GoTrue (`/auth/v1/logout?scope=global`) with the client's
 * current access token, WITHOUT `client.auth.signOut`: the client keeps the token in memory, so a
 * test can show what that kept token still reads once every session of the user is gone. Returns
 * GoTrue's HTTP status (204 on success).
 */
export async function signOutEverywhereKeepingToken(client: Db): Promise<number> {
  const { apiUrl, publishableKey } = localStack()
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  const token = data.session?.access_token
  if (!token) throw new Error('the client holds no session')
  const response = await fetch(`${apiUrl}/auth/v1/logout?scope=global`, {
    method: 'POST',
    headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
  })
  return response.status
}

/** PostgREST's error body: SQLSTATE in `code`, the domain code (AN0xx) in `message`. */
const PostgrestError = z.object({ code: z.nullable(z.string()), message: z.string() })

export type ServiceRpcResult = {
  data: unknown
  error: { code?: unknown; message?: unknown } | null
}

/**
 * One service_role RPC over PostgREST, the way the Edge Functions call the 0005 RPCs (step 1.3).
 * Untyped like theirs (`_shared/booking-rpc.ts`): the generated Args cannot express the null
 * arguments those RPCs take (a grant or a trusted device, an existing or a new client).
 */
export async function serviceRpc(
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<ServiceRpcResult> {
  const { apiUrl, secretKey } = localStack()
  const response = await fetch(`${apiUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  })
  const body: unknown = await response.json()
  if (response.ok) return { data: body, error: null }
  const error = PostgrestError.safeParse(body)
  return { data: null, error: error.success ? error.data : { message: `HTTP ${response.status}` } }
}
