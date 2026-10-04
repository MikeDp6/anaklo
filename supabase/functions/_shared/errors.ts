/**
 * Domain error codes raised by the database (0004+). The SQL raises them through
 * `private.raise_domain_error(code)`: SQLSTATE `P0001`, message = the code, hint = the name.
 * PostgREST forwards them as `{ code: 'P0001', message: 'AN001', hint: 'slot_taken' }`.
 *
 * errors.test.ts fails if this list and the SQL list disagree, or if a code has no i18n text
 * (`errors.<code>` in the `common` namespace: src/shared/i18n/{el,en}/common.json).
 * Pure module: no Deno/DOM/Node APIs (ADR-0002 §3).
 */
export const DOMAIN_ERRORS = {
  AN001: 'slot_taken',
  AN002: 'range_too_long',
  AN003: 'invalid_services',
  AN004: 'idempotency_conflict',
  AN005: 'outside_hours',
  AN006: 'buffer_overlap',
  AN007: 'invalid_client',
  AN008: 'invalid_staff',
  AN009: 'not_bookable',
  // 0005 (online booking, manage link). AN010–AN012 come from otp_verify's result, mapped by the
  // Edge Function; the SQL list carries them too so that both lists stay equal.
  AN010: 'otp_invalid',
  AN011: 'otp_expired',
  AN012: 'otp_attempts',
  AN013: 'rate_limited',
  AN014: 'verification_required',
  AN015: 'manage_token_invalid',
  AN016: 'change_too_late',
  AN017: 'sms_unavailable',
  AN018: 'phone_not_supported',
  AN019: 'otp_resend_too_soon',
  AN020: 'not_modifiable',
  // 0006 (pro app day operations)
  AN021: 'appointment_changed',
  AN022: 'correction_closed',
  AN023: 'not_started',
  // 0009 (security and members)
  AN024: 'slug_unavailable',
  AN025: 'future_appointments',
  AN026: 'last_owner',
  AN027: 'last_factor',
  AN028: 'already_member',
  AN029: 'staff_has_login',
  AN030: 'not_a_member',
  AN031: 'member_elsewhere',
  // 0010 (client card, merge, erasure)
  AN032: 'client_has_upcoming',
  AN033: 'client_unavailable',
  // 0012 (security hardening): adding a device while the account's enrolment is blocked
  AN034: 'enrolment_blocked',
} as const

export type DomainErrorCode = keyof typeof DOMAIN_ERRORS
export type DomainErrorName = (typeof DOMAIN_ERRORS)[DomainErrorCode]

export const DOMAIN_ERROR_CODES = Object.keys(DOMAIN_ERRORS) as DomainErrorCode[]

/** SQLSTATE of every domain error (plpgsql `raise_exception`). */
export const DOMAIN_ERROR_SQLSTATE = 'P0001'

export function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return typeof value === 'string' && Object.hasOwn(DOMAIN_ERRORS, value)
}

/**
 * The domain code of a PostgREST/supabase-js error, or null when the error is something else
 * (network, permission 42501, constraint, …).
 */
export function domainErrorCode(
  error: { readonly code?: unknown; readonly message?: unknown } | null | undefined,
): DomainErrorCode | null {
  if (!error || error.code !== DOMAIN_ERROR_SQLSTATE) return null
  return isDomainErrorCode(error.message) ? error.message : null
}
