import { supabase } from '@/shared/lib/supabase'
import { MembershipRows, type Membership } from './schema'
import type { AuthSignOutScope, SignOutResult } from './signOut'

/**
 * Supabase Auth and membership access for the pro app. Components and hooks never import this
 * client directly (CLAUDE.md rule 2): they go through these functions.
 */

export interface SessionUser {
  readonly userId: string
  readonly email: string | null
}

/**
 * Asks Auth for a 6-digit email code (ADR-0009 §1). Never creates a user: sign-up is closed.
 * Returns the raw error (or null); `mapSendCodeError` decides what the screen says.
 */
export async function sendEmailCode(email: string): Promise<unknown> {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    })
    return error
  } catch (error) {
    return error
  }
}

/** Checks the code; on success supabase-js stores the new session. Returns the raw error or null. */
export async function verifyEmailCode(email: string, token: string): Promise<unknown> {
  try {
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
    return error
  } catch (error) {
    return error
  }
}

/** The signed-in user on this device, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  const user = data.session?.user
  return user ? { userId: user.id, email: user.email ?? null } : null
}

/**
 * The user's memberships, read live from `business_members` (ADR-0009 §10): the role never
 * comes from the JWT. Members can see their colleagues' rows, hence the explicit user filter.
 */
export async function fetchMemberships(userId: string): Promise<Membership[]> {
  const { data, error } = await supabase
    .from('business_members')
    .select('business_id, role, staff_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return MembershipRows.parse(data).map((row) => ({
    businessId: row.business_id,
    role: row.role,
    staffId: row.staff_id,
  }))
}

/**
 * `local`: supabase-js removes the stored session even when Auth does not answer (offline, 5xx),
 * so this device is signed out either way, but the server may not have ended the session
 * (`ok: false`). `others`: every other session of the user; the stored session is kept, also when
 * Auth does not confirm. Without a session supabase-js would skip the call and report success,
 * so that case is `ok: false` here (nothing was confirmed).
 */
export async function signOutOfSupabase(scope: AuthSignOutScope): Promise<SignOutResult> {
  if (scope === 'others') {
    const { data } = await supabase.auth.getSession()
    if (!data.session) return { ok: false }
  }
  const { error } = await supabase.auth.signOut({ scope })
  return { ok: error === null }
}

/**
 * Calls `onSignedOut` whenever supabase-js drops the session: an explicit sign-out, in this or
 * another tab, or a refresh that failed because the session was revoked (role change, removal,
 * "all devices"). Returns the unsubscribe function.
 */
export function onSignedOut(onSignedOut: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') onSignedOut()
  })
  return () => data.subscription.unsubscribe()
}
