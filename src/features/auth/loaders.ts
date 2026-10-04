import { redirect, type LoaderFunctionArgs } from 'react-router'
import type { MemberRole } from '@/shared/lib/domain'
import { fetchMemberships, getSessionUser, type SessionUser } from './api'
import {
  decideAuthRoute,
  highestRole,
  needsSecondDevice,
  type Aal,
  type AuthRoute,
} from './mfa-route'
import { fetchAuthState, fetchEnrolmentBlocked, type VerifiedFactor } from './mfaApi'
import type { Membership } from './schema'
import { currentActiveUser, signOutRevoked } from './session'

/**
 * Route guards of the pro app. They run on every navigation and every return to the app
 * (revalidation), so the role is always read live from `business_members` (ADR-0009 §10) and the
 * session's level and devices live from GoTrue (contract 1.7 §6.2): `decideAuthRoute` sends an
 * owner or manager to the enrolment or to the code screen before any member page renders.
 * A guard that fails returns a redirect; React Router follows it before anything renders.
 */

/** The router's basename: request URLs carry it, `next` and redirects never do. */
export const APP_BASENAME = '/app'
export const LOGIN_PATH = '/login'
export const NO_ACCESS_PATH = '/no-access'
export const HOME_PATH = '/'
export const MFA_ENROLL_PATH = '/mfa/enroll'
export const MFA_CHALLENGE_PATH = '/mfa/challenge'
export const MFA_LOST_DEVICE_PATH = '/mfa/lost-device'
export const MFA_SECOND_DEVICE_PATH = '/mfa/second-device'
/** «Επικοινώνησε με τη Nous»: adding a device is blocked until Nous resets (contract 1.9b §4.2). */
export const MFA_BLOCKED_PATH = '/mfa/blocked'
export const SECURITY_PATH = '/settings/security'

/** Route id of the signed-in area; `useMember` reads its loader data. */
export const MEMBER_ROUTE_ID = 'member'

export interface MemberContext {
  readonly user: SessionUser
  /** The business the app shows. Several memberships are rare; the oldest comes first. */
  readonly membership: Membership
  readonly memberships: readonly Membership[]
}

/** The session behind a member page or a code screen (contract 1.7 §6.2). */
export interface AuthContext {
  readonly user: SessionUser
  readonly memberships: readonly Membership[]
  /** The highest role over all memberships: what `decideAuthRoute` decides on. */
  readonly highestRole: MemberRole
  readonly aal: Aal
  readonly verifiedFactors: readonly VerifiedFactor[]
  /**
   * Adding a device is blocked until Nous resets the account (contract 1.9b C3). Asked only for
   * an owner or manager without a verified device; false otherwise (the decision ignores it).
   */
  readonly enrolmentBlocked: boolean
}

/** What the member route's loader returns: `MemberContext` plus the decision's inputs. */
export interface MemberRouteData extends MemberContext, AuthContext {}

/** What the `mfa/*` routes' loaders return. */
export interface MfaRouteData extends AuthContext {
  /** Where to go once the code step is done (a safe in-app path), or null for «Σήμερα». */
  readonly next: string | null
}

/** A present session that has not been idle for 30 days (ADR-0009 §19), or → login. */
export async function requireSession(): Promise<SessionUser | Response> {
  return (await currentActiveUser()) ?? redirect(LOGIN_PATH)
}

/**
 * The session, the memberships and GoTrue's view of the session, read together (D21: `getUser`
 * on every run, so a revoked session is noticed here) → login, «no access», or the context. Only
 * when the decision would otherwise be the enrolment (owner/manager, no verified device) the
 * server is asked whether adding a device is blocked (contract 1.9b §4.2); a failure of that
 * call fails the guard like the other reads (the route's error page).
 */
async function readAuthContext(): Promise<AuthContext | Response> {
  const user = await requireSession()
  if (user instanceof Response) return user
  const [memberships, auth] = await Promise.all([fetchMemberships(user.userId), fetchAuthState()])
  if (auth.kind === 'revoked') {
    await signOutRevoked()
    return redirect(LOGIN_PATH)
  }
  const role = highestRole(memberships.map((membership) => membership.role))
  if (role === null) return redirect(NO_ACCESS_PATH)
  const enrolmentBlocked =
    role !== 'staff' && auth.verifiedFactors.length === 0 ? await fetchEnrolmentBlocked() : false
  return {
    user,
    memberships,
    highestRole: role,
    aal: auth.aal,
    verifiedFactors: auth.verifiedFactors,
    enrolmentBlocked,
  }
}

function decide(context: AuthContext): AuthRoute {
  return decideAuthRoute(
    context.highestRole,
    context.aal,
    context.verifiedFactors.length > 0,
    context.enrolmentBlocked,
  )
}

/** The in-app path of a request (`/app/settings?x=1` → `/settings?x=1`). */
export function appPath(request: Request): string {
  const url = new URL(request.url)
  const { pathname } = url
  const inApp =
    pathname === APP_BASENAME
      ? '/'
      : pathname.startsWith(`${APP_BASENAME}/`)
        ? pathname.slice(APP_BASENAME.length)
        : pathname
  return `${inApp}${url.search}`
}

/**
 * `next` only as an in-app path: starts with one `/` (never `//host` or a backslash, which
 * browsers read as another host), no control characters, and never a sign-in or code screen
 * (that would loop). Anything else → null («Σήμερα»).
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null
  if (/^\/(mfa|login|no-access)(\/|\?|#|$)/.test(value)) return null
  return value
}

/** `path?next=…`; «Σήμερα» is the default, so it is not carried. */
export function withNext(path: string, next: string | null): string {
  return next && next !== HOME_PATH ? `${path}?next=${encodeURIComponent(next)}` : path
}

/**
 * After the sign-in code (contract 1.7 §6.5): with only one device, «Πρόσθεσε δεύτερη συσκευή»
 * first (`needsSecondDevice`); otherwise straight to `next` or «Σήμερα».
 */
export function afterCodePath(verifiedCount: number, next: string | null): string {
  return needsSecondDevice(verifiedCount)
    ? withNext(MFA_SECOND_DEVICE_PATH, next)
    : (next ?? HOME_PATH)
}

/** Where a decision other than the current screen's sends the user. */
function redirectFor(route: AuthRoute, next: string | null): Response {
  switch (route) {
    case 'enroll':
      return redirect(MFA_ENROLL_PATH)
    case 'challenge':
      return redirect(withNext(MFA_CHALLENGE_PATH, next))
    case 'blocked':
      // No `next`: the screen leads nowhere until Nous has reset the account.
      return redirect(MFA_BLOCKED_PATH)
    case 'ok':
      return redirect(next ?? HOME_PATH)
  }
}

/** A session, at least one membership and `decideAuthRoute` = ok, or → the screen it decides. */
export async function requireMembership({
  request,
}: LoaderFunctionArgs): Promise<MemberRouteData | Response> {
  const context = await readAuthContext()
  if (context instanceof Response) return context
  const route = decide(context)
  if (route !== 'ok') return redirectFor(route, safeNext(appPath(request)))
  const [membership] = context.memberships
  if (!membership) return redirect(NO_ACCESS_PATH)
  return { ...context, membership }
}

/**
 * `mfa/enroll` (expected `enroll`), `mfa/challenge`, `mfa/lost-device` (expected `challenge`) and
 * `mfa/blocked` (expected `blocked`): only while that is the decision; otherwise its own screen
 * (`ok` → `next` or «Σήμερα»). So once Nous has reset a blocked account, the next check (a
 * return to the app) moves the user on, and a blocked one never sees the wizard.
 */
export function mfaLoader(expected: Exclude<AuthRoute, 'ok'>) {
  return async ({ request }: LoaderFunctionArgs): Promise<MfaRouteData | Response> => {
    const next = safeNext(new URL(request.url).searchParams.get('next'))
    const context = await readAuthContext()
    if (context instanceof Response) return context
    const route = decide(context)
    if (route !== expected) return redirectFor(route, next)
    return { ...context, next }
  }
}

/**
 * `mfa/second-device` (contract 1.7 §6.5): an owner or manager past the code step with exactly
 * one device. Staff, or a second device already there → `next` or «Σήμερα».
 */
export async function secondDeviceLoader({
  request,
}: LoaderFunctionArgs): Promise<MfaRouteData | Response> {
  const next = safeNext(new URL(request.url).searchParams.get('next'))
  const context = await readAuthContext()
  if (context instanceof Response) return context
  const route = decide(context)
  if (route !== 'ok') return redirectFor(route, next)
  if (context.highestRole === 'staff' || !needsSecondDevice(context.verifiedFactors.length)) {
    return redirect(next ?? HOME_PATH)
  }
  return { ...context, next }
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
