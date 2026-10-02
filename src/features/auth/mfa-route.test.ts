import { describe, expect, it } from 'vitest'
import type { MemberRole } from '@/shared/lib/domain'
import {
  decideAuthRoute,
  highestRole,
  needsSecondDevice,
  toAal,
  type Aal,
  type AuthRoute,
} from './mfa-route'

/** Plan 1.7 «Διαδρομή μετά τη σύνδεση», ADR-0009 §10: every combination, one case each. */
const TABLE: readonly [MemberRole, Aal, boolean, AuthRoute][] = [
  ['staff', 'aal1', false, 'ok'],
  ['staff', 'aal1', true, 'ok'],
  ['staff', 'aal2', false, 'ok'],
  ['staff', 'aal2', true, 'ok'],
  ['manager', 'aal1', false, 'enroll'],
  ['manager', 'aal1', true, 'challenge'],
  ['manager', 'aal2', false, 'enroll'],
  ['manager', 'aal2', true, 'ok'],
  ['owner', 'aal1', false, 'enroll'],
  ['owner', 'aal1', true, 'challenge'],
  ['owner', 'aal2', false, 'enroll'],
  ['owner', 'aal2', true, 'ok'],
]

describe('decideAuthRoute (contract 1.7 §6.2)', () => {
  it.each(TABLE)('%s at %s, verified device: %s → %s', (role, aal, factor, route) => {
    expect(decideAuthRoute(role, aal, factor)).toBe(route)
  })

  it('covers all 12 combinations exactly once', () => {
    const seen = new Set(TABLE.map(([role, aal, factor]) => `${role}/${aal}/${String(factor)}`))
    expect(seen.size).toBe(12)
  })

  it('aal2 without a verified device (right after a Nous reset) enrols', () => {
    expect(decideAuthRoute('owner', 'aal2', false)).toBe('enroll')
  })
})

describe('highestRole', () => {
  it('owner > manager > staff, whatever the order', () => {
    expect(highestRole(['staff', 'owner', 'manager'])).toBe('owner')
    expect(highestRole(['staff', 'manager'])).toBe('manager')
    expect(highestRole(['manager', 'staff'])).toBe('manager')
    expect(highestRole(['staff'])).toBe('staff')
  })

  it('no membership → null', () => {
    expect(highestRole([])).toBeNull()
  })
})

describe('toAal', () => {
  it('only aal2 is aal2', () => {
    expect(toAal('aal2')).toBe('aal2')
    expect(toAal('aal1')).toBe('aal1')
    expect(toAal(null)).toBe('aal1')
    expect(toAal(undefined)).toBe('aal1')
    expect(toAal('aal3')).toBe('aal1')
  })
})

describe('needsSecondDevice', () => {
  it('exactly one verified device → the reminder', () => {
    expect([0, 1, 2, 3].map(needsSecondDevice)).toEqual([false, true, false, false])
  })
})
