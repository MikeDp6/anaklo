import type { MemberRole } from '@/shared/lib/domain'

/**
 * Where a signed-in member goes after the email code (plan 1.7 «Διαδρομή μετά τη σύνδεση»,
 * ADR-0009 §10, contracts 1.7 §6.2 and 1.9b §4.1). Pure, so every combination is a Vitest case.
 * The role is the highest of the user's memberships, read live from `business_members`, never
 * from the JWT.
 *
 * | role          | aal  | verified factor | enrolment blocked | route     |
 * |---------------|------|-----------------|-------------------|-----------|
 * | staff         | any  | any             | any               | ok        |
 * | owner/manager | any  | no              | yes               | blocked   |
 * | owner/manager | any  | no              | no                | enroll    |
 * | owner/manager | aal1 | yes             | any               | challenge |
 * | owner/manager | aal2 | yes             | any               | ok        |
 *
 * `blocked` (contract 1.9b §4.1, C3): a device was removed without going through the app and none
 * is left, so the server refuses a new one until Nous has checked the person and reset the
 * account (`factor_enrolment_blocked()`). The flag is consulted only without a verified factor.
 * Freshness is not a route: the server asks for it per action and the code sheet answers.
 */
export type Aal = 'aal1' | 'aal2'
export type AuthRoute = 'enroll' | 'challenge' | 'blocked' | 'ok'

export function decideAuthRoute(
  role: MemberRole,
  aal: Aal,
  hasVerifiedFactor: boolean,
  enrolmentBlocked: boolean,
): AuthRoute {
  if (role === 'staff') return 'ok'
  if (!hasVerifiedFactor) return enrolmentBlocked ? 'blocked' : 'enroll'
  return aal === 'aal2' ? 'ok' : 'challenge'
}

const ROLE_RANK: Readonly<Record<MemberRole, number>> = { owner: 3, manager: 2, staff: 1 }

/** owner > manager > staff; no membership → null. */
export function highestRole(roles: readonly MemberRole[]): MemberRole | null {
  let highest: MemberRole | null = null
  for (const role of roles) {
    if (highest === null || ROLE_RANK[role] > ROLE_RANK[highest]) highest = role
  }
  return highest
}

/** The session's assurance level; anything but `aal2` (null, unknown) counts as `aal1`. */
export function toAal(value: unknown): Aal {
  return value === 'aal2' ? 'aal2' : 'aal1'
}

/**
 * «Πρόσθεσε δεύτερη συσκευή» after the first enrolment and after every sign-in while only one
 * device is verified. None (not enrolled yet) is the enrolment's job, not this reminder's.
 */
export function needsSecondDevice(verifiedFactorCount: number): boolean {
  return verifiedFactorCount === 1
}
