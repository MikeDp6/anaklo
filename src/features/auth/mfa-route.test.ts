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

/**
 * Plan 1.7 «Διαδρομή μετά τη σύνδεση», ADR-0009 §10, contract 1.9b §4.1: every combination of
 * role × level × verified device × blocked enrolment, one case each.
 */
const TABLE: readonly [MemberRole, Aal, boolean, boolean, AuthRoute][] = [
  ['staff', 'aal1', false, false, 'ok'],
  ['staff', 'aal1', false, true, 'ok'],
  ['staff', 'aal1', true, false, 'ok'],
  ['staff', 'aal1', true, true, 'ok'],
  ['staff', 'aal2', false, false, 'ok'],
  ['staff', 'aal2', false, true, 'ok'],
  ['staff', 'aal2', true, false, 'ok'],
  ['staff', 'aal2', true, true, 'ok'],
  ['manager', 'aal1', false, false, 'enroll'],
  ['manager', 'aal1', false, true, 'blocked'],
  ['manager', 'aal1', true, false, 'challenge'],
  ['manager', 'aal1', true, true, 'challenge'],
  ['manager', 'aal2', false, false, 'enroll'],
  ['manager', 'aal2', false, true, 'blocked'],
  ['manager', 'aal2', true, false, 'ok'],
  ['manager', 'aal2', true, true, 'ok'],
  ['owner', 'aal1', false, false, 'enroll'],
  ['owner', 'aal1', false, true, 'blocked'],
  ['owner', 'aal1', true, false, 'challenge'],
  ['owner', 'aal1', true, true, 'challenge'],
  ['owner', 'aal2', false, false, 'enroll'],
  ['owner', 'aal2', false, true, 'blocked'],
  ['owner', 'aal2', true, false, 'ok'],
  ['owner', 'aal2', true, true, 'ok'],
]

describe('decideAuthRoute (contracts 1.7 §6.2, 1.9b §4.1)', () => {
  it.each(TABLE)(
    '%s at %s, verified device: %s, enrolment blocked: %s → %s',
    (role, aal, factor, blocked, route) => {
      expect(decideAuthRoute(role, aal, factor, blocked)).toBe(route)
    },
  )

  it('covers all 24 combinations exactly once', () => {
    const seen = new Set(
      TABLE.map(
        ([role, aal, factor, blocked]) => `${role}/${aal}/${String(factor)}/${String(blocked)}`,
      ),
    )
    expect(seen.size).toBe(24)
  })

  it('aal2 without a verified device (right after a Nous reset) enrols', () => {
    expect(decideAuthRoute('owner', 'aal2', false, false)).toBe('enroll')
  })

  it('a blocked owner or manager never reaches the wizard; staff are never blocked', () => {
    for (const role of ['owner', 'manager'] as const) {
      for (const aal of ['aal1', 'aal2'] as const) {
        expect(decideAuthRoute(role, aal, false, true)).toBe('blocked')
      }
    }
    expect(decideAuthRoute('staff', 'aal1', false, true)).toBe('ok')
  })

  it('with a verified device the flag changes nothing', () => {
    for (const role of ['owner', 'manager', 'staff'] as const) {
      for (const aal of ['aal1', 'aal2'] as const) {
        expect(decideAuthRoute(role, aal, true, true)).toBe(decideAuthRoute(role, aal, true, false))
      }
    }
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
