import { describe, expect, it } from 'vitest'
import type { StaffMember } from '@/features/staff/schema'
import {
  freeStaff,
  INVITE_DEFAULTS,
  InviteFormSchema,
  MemberRows,
  roleChangeConsequences,
  SetRoleResponse,
  toInviteBody,
  toMembers,
  type Member,
} from './schema'

// Test data only (synthetic ids and the demo shop's addresses).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const OWNER = '00000000-0000-4000-8000-00000000a001'
const ALEX = '00000000-0000-4000-8000-00000000a003'
const NIKOS_ROW = '00000000-0000-4000-8000-000000000101'
const ALEX_ROW = '00000000-0000-4000-8000-000000000102'
const MARIA_ROW = '00000000-0000-4000-8000-000000000103'
const PETROS_ROW = '00000000-0000-4000-8000-000000000104'

describe('list_members rows (contract 1.7 §2.6)', () => {
  it('parses the RPC rows and keeps the server order', () => {
    const rows = MemberRows.parse([
      {
        user_id: OWNER,
        email: 'owner@demo-barber.test',
        role: 'owner',
        staff_id: NIKOS_ROW,
        staff_name: 'Νίκος',
        created_at: '2026-09-01T08:00:00.123456+00:00',
        last_sign_in_at: '2026-10-01T08:00:00+00:00',
        is_self: true,
      },
      {
        user_id: ALEX,
        email: 'alex@demo-barber.test',
        role: 'staff',
        staff_id: null,
        staff_name: null,
        created_at: '2026-09-02T08:00:00+00:00',
        last_sign_in_at: null,
        is_self: false,
        extra: 'ignored',
      },
    ])
    expect(toMembers(rows)).toEqual([
      {
        userId: OWNER,
        email: 'owner@demo-barber.test',
        role: 'owner',
        staffId: NIKOS_ROW,
        staffName: 'Νίκος',
        signedIn: true,
        isSelf: true,
      },
      {
        userId: ALEX,
        email: 'alex@demo-barber.test',
        role: 'staff',
        staffId: null,
        staffName: null,
        signedIn: false,
        isSelf: false,
      },
    ])
  })

  it('refuses a role outside the CHECK list', () => {
    expect(() =>
      MemberRows.parse([
        {
          user_id: OWNER,
          email: null,
          role: 'boss',
          staff_id: null,
          staff_name: null,
          last_sign_in_at: null,
          is_self: false,
        },
      ]),
    ).toThrow()
  })

  it('set_member_role answers with the previous role', () => {
    expect(
      SetRoleResponse.parse({
        user_id: ALEX,
        role: 'manager',
        previous_role: 'staff',
        changed: true,
      }),
    ).toEqual({ user_id: ALEX, role: 'manager', previous_role: 'staff', changed: true })
  })
})

describe('the invitation form (contract 1.7 §6.8, D4)', () => {
  it('defaults to staff with no calendar row', () => {
    expect(INVITE_DEFAULTS).toEqual({ email: '', role: 'staff', staffId: '' })
  })

  it.each(['new@example.test', '  New@Example.TEST  '])('accepts %j', (email) => {
    expect(InviteFormSchema.safeParse({ ...INVITE_DEFAULTS, email }).success).toBe(true)
  })

  it.each(['', 'not-an-email', 'a@b', `${'x'.repeat(250)}@example.test`])(
    'refuses %j with the email text key',
    (email) => {
      const result = InviteFormSchema.safeParse({ ...INVITE_DEFAULTS, email })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.message).toBe('members.errors.email')
    },
  )

  it('only manager or staff: an owner comes by promotion', () => {
    expect(
      InviteFormSchema.safeParse({ ...INVITE_DEFAULTS, email: 'a@example.test', role: 'owner' })
        .success,
    ).toBe(false)
  })

  it('the body trims and lower-cases the email; «Κανένας» is a null staff row', () => {
    expect(
      toInviteBody(BUSINESS, { email: ' New@Example.TEST ', role: 'manager', staffId: '' }),
    ).toEqual({ business_id: BUSINESS, email: 'new@example.test', role: 'manager', staff_id: null })
    expect(
      toInviteBody(BUSINESS, { email: 'a@example.test', role: 'staff', staffId: MARIA_ROW }),
    ).toEqual({
      business_id: BUSINESS,
      email: 'a@example.test',
      role: 'staff',
      staff_id: MARIA_ROW,
    })
  })
})

describe('freeStaff', () => {
  const staff: StaffMember[] = [
    { id: NIKOS_ROW, displayName: 'Νίκος', color: null, sort: 0, active: true },
    { id: ALEX_ROW, displayName: 'Άλεξ', color: null, sort: 1, active: true },
    { id: MARIA_ROW, displayName: 'Μαρία', color: null, sort: 2, active: true },
    { id: PETROS_ROW, displayName: 'Πέτρος', color: null, sort: 3, active: false },
  ]
  const member = (userId: string, staffId: string | null): Member => ({
    userId,
    email: null,
    role: 'staff',
    staffId,
    staffName: null,
    signedIn: true,
    isSelf: false,
  })

  it('offers the active rows no member holds yet', () => {
    expect(
      freeStaff(staff, [member(OWNER, NIKOS_ROW), member(ALEX, ALEX_ROW)]).map((row) => row.id),
    ).toEqual([MARIA_ROW])
  })

  it('with no links: every active row', () => {
    expect(freeStaff(staff, [member(OWNER, null)]).map((row) => row.id)).toEqual([
      NIKOS_ROW,
      ALEX_ROW,
      MARIA_ROW,
    ])
  })
})

describe('roleChangeConsequences (written before «Αποθήκευση»)', () => {
  it.each([
    ['owner', 'owner', []],
    ['staff', 'staff', []],
    ['manager', 'owner', ['signOut']],
    ['owner', 'manager', ['signOut']],
    ['owner', 'staff', ['signOut', 'dropDevices']],
    ['manager', 'staff', ['signOut', 'dropDevices']],
    ['staff', 'manager', ['signOut', 'enroll']],
    ['staff', 'owner', ['signOut', 'enroll']],
  ] as const)('%s → %s', (from, to, expected) => {
    expect(roleChangeConsequences(from, to)).toEqual(expected)
  })
})
