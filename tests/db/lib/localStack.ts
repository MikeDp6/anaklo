import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
