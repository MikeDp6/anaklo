/**
 * Domain error codes raised by the database (0004+). The SQL raises them through
 * `private.raise_domain_error(code)`: SQLSTATE `P0001`, message = the code, hint = the name.
 * PostgREST forwards them as `{ code: 'P0001', message: 'AN001', hint: 'slot_taken' }`.
 *
 * errors.test.ts fails if this list and the SQL list disagree, or if a code has no i18n text
 * (`errors.<code>` in el.json and en.json). Pure module: no Deno/DOM/Node APIs (ADR-0002 §3).
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
