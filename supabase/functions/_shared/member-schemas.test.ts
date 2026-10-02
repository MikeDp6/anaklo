import { describe, expect, it } from 'vitest'
import {
  AuthorizeFactorResult,
  FunctionErrorBody,
  InviteMemberBody,
  ManageFactorsBody,
  MemberEmail,
} from './member-schemas.ts'

const ID = '00000000-0000-4000-8000-000000000001'

describe('member schemas (contract 1.7 §3.1)', () => {
  it('trims and lower-cases the email before checking it', () => {
    expect(MemberEmail.parse('  Nikos@Shop.GR ')).toBe('nikos@shop.gr')
    expect(MemberEmail.safeParse('nikos@').success).toBe(false)
    expect(MemberEmail.safeParse(`${'a'.repeat(250)}@b.gr`).success).toBe(false)
    expect(MemberEmail.safeParse(`${'a'.repeat(249)}@b.gr`).success).toBe(true)
  })

  it('invites a manager or a staff member only, with an explicit staff link', () => {
    const base = { business_id: ID, email: 'a@b.gr', staff_id: null }
    expect(InviteMemberBody.safeParse({ ...base, role: 'staff' }).success).toBe(true)
    expect(InviteMemberBody.safeParse({ ...base, role: 'manager', staff_id: ID }).success).toBe(
      true,
    )
    expect(InviteMemberBody.safeParse({ ...base, role: 'owner' }).success).toBe(false)
    expect(
      InviteMemberBody.safeParse({ business_id: ID, email: 'a@b.gr', role: 'staff' }).success,
    ).toBe(false)
    expect(InviteMemberBody.safeParse({ ...base, role: 'staff', extra: 1 }).success).toBe(false)
  })

  it('accepts only a removal of one factor', () => {
    expect(ManageFactorsBody.safeParse({ action: 'remove', factor_id: ID }).success).toBe(true)
    expect(ManageFactorsBody.safeParse({ action: 'add', factor_id: ID }).success).toBe(false)
    expect(ManageFactorsBody.safeParse({ action: 'remove' }).success).toBe(false)
  })

  it('reads the flat error body, with or without a hint', () => {
    expect(
      FunctionErrorBody.parse({ code: '42501', message: 'x', hint: 'fresh_totp_required' }),
    ).toEqual({ code: '42501', message: 'x', hint: 'fresh_totp_required' })
    expect(FunctionErrorBody.safeParse({ code: '42501', message: 'x' }).success).toBe(false)
  })

  it('reads a grant of either action', () => {
    const grant = { grant_id: ID, user_id: ID, expires_at: '2026-10-02T10:10:00+00:00' }
    expect(
      AuthorizeFactorResult.safeParse({ ...grant, action: 'add', factor_id: null }).success,
    ).toBe(true)
    expect(
      AuthorizeFactorResult.safeParse({ ...grant, action: 'remove', factor_id: ID }).success,
    ).toBe(true)
  })
})
