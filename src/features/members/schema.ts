import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'
import {
  InviteRole,
  MemberEmail,
  type InviteMemberBody,
  type InviteMemberResult,
} from '@fn-shared/member-schemas.ts'
import { normaliseEmail } from '@/features/auth/schema'
import type { StaffMember } from '@/features/staff/schema'
import { MemberRole } from '@/shared/lib/domain'

/**
 * Members of a business (contract 1.7 §6.8). Answers are parsed leniently (extra keys ignored);
 * the rules (who may change what, the last owner, sessions and factors) live in SQL only.
 */

/** A row of `list_members` (contract 1.7 §2.6), already in the server's order. */
export const MemberRow = z.object({
  user_id: Id,
  email: z.nullable(z.string()),
  role: MemberRole,
  staff_id: z.nullable(Id),
  staff_name: z.nullable(z.string()),
  last_sign_in_at: z.nullable(z.string()),
  is_self: z.boolean(),
})
export const MemberRows = z.array(MemberRow)

export interface Member {
  readonly userId: string
  readonly email: string | null
  readonly role: MemberRole
  readonly staffId: string | null
  readonly staffName: string | null
  /** False until their first sign-in («Δεν έχει συνδεθεί ακόμη»). */
  readonly signedIn: boolean
  /** The caller's own row: no actions on it in 1.7 (D10). */
  readonly isSelf: boolean
}

export function toMembers(rows: z.infer<typeof MemberRows>): Member[] {
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
    staffId: row.staff_id,
    staffName: row.staff_name,
    signedIn: row.last_sign_in_at !== null,
    isSelf: row.is_self,
  }))
}

/** `set_member_role`'s answer; `changed: false` = the role was already this one (D9). */
export const SetRoleResponse = z.object({
  user_id: Id,
  role: MemberRole,
  previous_role: MemberRole,
  changed: z.boolean(),
})
export type SetRoleResult = z.infer<typeof SetRoleResponse>

/** `remove_member`'s answer; `removed: false` = no longer a member (D9). */
export const RemoveResponse = z.object({
  user_id: Id,
  removed: z.boolean(),
})
export type RemoveResult = z.infer<typeof RemoveResponse>

export interface RoleChange {
  readonly userId: string
  readonly role: MemberRole
}

// ---------------------------------------------------------------------------------------------
// Invitation (contract 1.7 §6.8, D4: manager or staff; an owner comes by promotion)
// ---------------------------------------------------------------------------------------------

export { INVITE_ROLES, MAX_EMAIL_LENGTH } from '@fn-shared/member-schemas.ts'

export type InviteBody = InviteMemberBody
/** `invite-member`'s answer; `added: false` = already a member with that role (D9). */
export type InviteResult = InviteMemberResult

/**
 * The invitation form (React Hook Form). Messages are `pro` i18n keys. The email is checked with
 * the function's own schema (`MemberEmail`: trimmed, lower-cased, an address, ≤ 254), so the form
 * and `invite-member` never disagree.
 */
export const InviteFormSchema = z.object({
  email: z
    .string()
    .check(z.refine((value) => MemberEmail.safeParse(value).success, 'members.errors.email')),
  role: InviteRole,
  /** '' = «Κανένας». */
  staffId: z.string(),
})
export type InviteFormValues = z.infer<typeof InviteFormSchema>

export const INVITE_DEFAULTS: InviteFormValues = { email: '', role: 'staff', staffId: '' }

export function toInviteBody(businessId: string, values: InviteFormValues): InviteBody {
  return {
    business_id: businessId,
    email: normaliseEmail(values.email),
    role: values.role,
    staff_id: values.staffId === '' ? null : values.staffId,
  }
}

/**
 * The calendar rows an invitation may link: active, and held by no member yet (one login per
 * staff row; the server refuses a taken one with AN029 anyway).
 */
export function freeStaff(
  staff: readonly StaffMember[],
  members: readonly Member[],
): StaffMember[] {
  const held = new Set(members.flatMap((member) => (member.staffId ? [member.staffId] : [])))
  return staff.filter((row) => row.active && !held.has(row.id))
}

// ---------------------------------------------------------------------------------------------
// What a role change does (written before «Αποθήκευση», contract 1.7 §6.8)
// ---------------------------------------------------------------------------------------------

export type RoleConsequence = 'signOut' | 'dropDevices' | 'enroll'

function usesCodeDevices(role: MemberRole): boolean {
  return role === 'owner' || role === 'manager'
}

/**
 * The texts shown for a change `from → to`: every change signs the user out everywhere; owner or
 * manager → staff deletes their code devices; staff → owner or manager enrols at the next sign-in.
 */
export function roleChangeConsequences(from: MemberRole, to: MemberRole): RoleConsequence[] {
  if (from === to) return []
  const consequences: RoleConsequence[] = ['signOut']
  if (usesCodeDevices(from) && !usesCodeDevices(to)) consequences.push('dropDevices')
  if (!usesCodeDevices(from) && usesCodeDevices(to)) consequences.push('enroll')
  return consequences
}

/** The role radio of `MemberSheet` (React Hook Form). */
export const RoleFormSchema = z.object({ role: MemberRole })
export type RoleFormValues = z.infer<typeof RoleFormSchema>
