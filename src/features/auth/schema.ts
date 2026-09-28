import { z } from 'zod/mini'
import { MemberRole } from '@/shared/lib/domain'

/** What the user types on the login screen. */
export const LoginEmail = z.email()
export const LoginCode = z.string().check(z.regex(/^\d{6}$/))

/** Rows of `business_members` as the pro app reads them (role narrowed to the CHECK list). */
export const MembershipRows = z.array(
  z.object({
    business_id: z.string(),
    role: MemberRole,
    staff_id: z.nullable(z.string()),
  }),
)

export interface Membership {
  readonly businessId: string
  readonly role: MemberRole
  readonly staffId: string | null
}

/** Normalises what the user typed: spaces around, and upper case from iOS auto-capitalisation. */
export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase()
}

/** Keeps only digits, so a pasted "123 456" or autofilled code still works. */
export function normaliseCode(input: string): string {
  return input.replace(/\D/g, '').slice(0, 6)
}
