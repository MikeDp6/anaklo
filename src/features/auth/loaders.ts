import { redirect } from 'react-router'
import { fetchMemberships, getSessionUser, type SessionUser } from './api'
import type { Membership } from './schema'
import { currentActiveUser } from './session'

/**
 * Route guards of the pro app. They run on every navigation and every return to the app
 * (revalidation), so the role is always read live from `business_members` (ADR-0009 §10).
 * A guard that fails returns a redirect; React Router follows it before anything renders.
 */

export const LOGIN_PATH = '/login'
export const NO_ACCESS_PATH = '/no-access'
export const HOME_PATH = '/'

/** Route id of the signed-in area; `useMember` reads its loader data. */
export const MEMBER_ROUTE_ID = 'member'

export interface MemberContext {
  readonly user: SessionUser
  /** The business the app shows. Several memberships are rare; the oldest comes first. */
  readonly membership: Membership
  readonly memberships: readonly Membership[]
}

/** A present session that has not been idle for 30 days (ADR-0009 §19), or → login. */
export async function requireSession(): Promise<SessionUser | Response> {
  return (await currentActiveUser()) ?? redirect(LOGIN_PATH)
}

/** A session and at least one membership, or → login / «no access». */
export async function requireMembership(): Promise<MemberContext | Response> {
  const user = await requireSession()
  if (user instanceof Response) return user
  const memberships = await fetchMemberships(user.userId)
  const [membership] = memberships
  if (!membership) return redirect(NO_ACCESS_PATH)
  return { user, membership, memberships }
}

/** The login screen is for signed-out devices only. */
export async function loginLoader(): Promise<Response | null> {
  return (await getSessionUser()) ? redirect(HOME_PATH) : null
}

/** Signed in, but not a member anywhere. Someone who became a member goes on to the app. */
export async function noAccessLoader(): Promise<{ user: SessionUser } | Response> {
  const user = await requireSession()
  if (user instanceof Response) return user
  const memberships = await fetchMemberships(user.userId)
  return memberships.length > 0 ? redirect(HOME_PATH) : { user }
}
