import { z } from 'zod/mini'
import { Id } from './booking-schemas.ts'

/**
 * Bodies and answers of the member Edge Functions `invite-member` and `manage-factors` (contract
 * 1.7 §3.1), and the RPC results they read. Shared by the functions and the pro app (through
 * `@fn-shared`), so both sides validate the same shape. Pure (ADR-0002 §3).
 */

/** The longest address SMTP allows (RFC 5321 path limit); GoTrue refuses longer ones too. */
export const MAX_EMAIL_LENGTH = 254

/** Roles an invitation may give (contract 1.7 D4): a new owner comes only by promotion. */
export const INVITE_ROLES = ['manager', 'staff'] as const
export const InviteRole = z.enum(INVITE_ROLES)
export type InviteRole = z.infer<typeof InviteRole>

/** Trimmed and lower-cased first, so `  Nikos@Shop.GR ` and `nikos@shop.gr` are one account. */
export const MemberEmail = z.pipe(
  z.string().check(z.trim(), z.toLowerCase()),
  z.email().check(z.maxLength(MAX_EMAIL_LENGTH)),
)

export const InviteMemberBody = z.strictObject({
  business_id: Id,
  email: MemberEmail,
  role: InviteRole,
  staff_id: z.nullable(Id),
})
export type InviteMemberBody = z.infer<typeof InviteMemberBody>
/** What the pro app sends (before trimming and lower-casing). */
export type InviteMemberInput = z.input<typeof InviteMemberBody>

export const InviteMemberResult = z.object({
  user_id: Id,
  email: z.string(),
  role: InviteRole,
  staff_id: z.nullable(Id),
  /** false: the user was already a member with this role and staff link (nothing written). */
  added: z.boolean(),
  /** true: the Auth user was created by this call (no invite link, no email sent). */
  user_created: z.boolean(),
})
export type InviteMemberResult = z.infer<typeof InviteMemberResult>

/**
 * Only removal goes through the function; an addition is GoTrue's own enrolment (§2.6). The id is
 * lower-cased: Postgres answers uuids in lower case, so the grant of `authorize_factor_change`
 * matches it as text (an upper-case id would otherwise leave a committed grant and a 500).
 */
export const ManageFactorsBody = z.strictObject({
  action: z.literal('remove'),
  factor_id: Id.check(z.toLowerCase()),
})
export type ManageFactorsBody = z.infer<typeof ManageFactorsBody>

export const ManageFactorsResult = z.object({
  removed: z.literal(true),
  factor_id: Id,
})
export type ManageFactorsResult = z.infer<typeof ManageFactorsResult>

/**
 * Every error of the member functions (contract 1.7 D12): the PostgREST shape, flat, so one
 * classifier (`classifyRpcFailure`) serves RPCs and functions alike. `hint` is null when absent.
 */
export const FunctionErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.nullable(z.string()),
})
export type FunctionErrorBody = z.infer<typeof FunctionErrorBody>

export const FACTOR_CHANGE_ACTIONS = ['add', 'remove'] as const

/** `authorize_factor_change` (0009 §2.6): the grant the caller just received. */
export const AuthorizeFactorResult = z.object({
  grant_id: Id,
  user_id: Id,
  action: z.enum(FACTOR_CHANGE_ACTIONS),
  factor_id: z.nullable(Id),
  expires_at: z.string(),
})
export type AuthorizeFactorResult = z.infer<typeof AuthorizeFactorResult>

/** `add_member` (0009 §2.7, service_role only). */
export const AddMemberResult = z.object({
  business_id: Id,
  user_id: Id,
  role: InviteRole,
  staff_id: z.nullable(Id),
  added: z.boolean(),
})
export type AddMemberResult = z.infer<typeof AddMemberResult>

/** `user_id_for_email` (0009 §2.7, service_role only): null when there is no such account. */
export const UserIdForEmailResult = z.nullable(Id)
