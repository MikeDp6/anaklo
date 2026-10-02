import { StepUpHint } from '@fn-shared/domain.ts'
import { domainErrorCode, type DomainErrorCode } from '@fn-shared/errors.ts'

/**
 * How a pro-app call to Supabase failed (contract 1.4 §3.6). The screens never show `message`:
 * they map the failure to an i18n key with `rpcFailureMessageKey`.
 *
 * - `offline`: the outcome is unknown (no answer, timeout, gateway without a SQLSTATE). A write
 *   may have been saved: the sheet locks and offers only the identical retry (same key).
 * - `domain`: an `AN0xx` code of `_shared/errors.ts`.
 * - `stepUp`: `42501` with the hint `aal2_required` or `fresh_totp_required` (contract 1.7 §6.6):
 *   a critical action needs a fresh code from the authenticator app. Only `withStepUp` acts on it
 *   (the code sheet, then exactly one retry); the server alone decides when (rule 13).
 * - `stepUpCancelled`: the user closed that sheet; thrown by `withStepUp`, never classified from
 *   a server error. Nothing was done.
 * - `unauthorized`: HTTP 401 or PostgREST `PGRST301`/`PGRST303`: no valid session. The route
 *   guards decide again (`decideAuthRoute`).
 * - `forbidden`: `42501` without a step-up hint (not a member, not your appointment, a role that
 *   may not do this, or an enrolled owner/manager whose session is not `aal2`).
 * - `overlap`: `23P01`, an exclusion constraint (two intervals of a day, two closures or two time
 *   offs overlap; contract 1.6 §3.6). Screens show their own text.
 * - `invalid`: a CHECK or a shape the database refused (`23514`, `22023`, `22P02`, `22007`,
 *   `22008`): «Κάποια τιμή δεν είναι έγκυρη».
 * - `gone`: an update matched no row (another device deleted it meanwhile); thrown by the
 *   `api.ts` that asked for the updated row back, never classified from a server error.
 * - `unknown`: anything else.
 */
export type RpcFailureInfo =
  | { readonly kind: 'offline' }
  | { readonly kind: 'domain'; readonly code: DomainErrorCode }
  | { readonly kind: 'stepUp'; readonly hint: StepUpHint }
  | { readonly kind: 'stepUpCancelled' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'overlap' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unknown' }

/** What the pro `api.ts` functions throw, so TanStack Query hands the classified failure on. */
export class RpcFailure extends Error {
  readonly failure: RpcFailureInfo

  constructor(failure: RpcFailureInfo, options?: { cause?: unknown }) {
    super(`rpc failure: ${failure.kind === 'domain' ? failure.code : failure.kind}`, options)
    this.name = 'RpcFailure'
    this.failure = failure
  }
}

/** Errors a `fetch` throws when there is no answer: network down, abort, 15″ timeout. */
const NO_ANSWER_NAMES: ReadonlySet<string> = new Set([
  'TypeError',
  'AbortError',
  'TimeoutError',
  'FetchError',
])
/** Gateways answer these when the database is unreachable; without a SQLSTATE nothing ran. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504])
const SQLSTATE = /^[0-9A-Z]{5}$/
/** PostgREST: the JWT is invalid (`PGRST301`) or expired (`PGRST303`). */
const NO_SESSION_CODES: ReadonlySet<string> = new Set(['PGRST301', 'PGRST303'])
/** Exclusion constraint violated (`time_off_no_overlap`, `working_hours_no_overlap`, …). */
const OVERLAP_SQLSTATE = '23P01'
/** check_violation, invalid_parameter_value, invalid_text_representation, datetime errors. */
const INVALID_SQLSTATES: ReadonlySet<string> = new Set([
  '23514',
  '22023',
  '22P02',
  '22007',
  '22008',
])

function field(error: object, name: string): unknown {
  return name in error ? (error as Record<string, unknown>)[name] : undefined
}

/**
 * `error` is what supabase-js returned (`{ code, message, … }` with the response `status`, 0
 * when fetch failed) or what was thrown. postgrest-js reports a failed fetch as a status-0 error
 * whose message starts with the thrown error's name (`TypeError: Failed to fetch`).
 */
export function classifyRpcFailure(error: unknown, status?: number): RpcFailureInfo {
  if (error instanceof RpcFailure) return error.failure
  if (typeof error !== 'object' || error === null) return { kind: 'unknown' }

  const name = field(error, 'name')
  if (typeof name === 'string' && NO_ANSWER_NAMES.has(name)) return { kind: 'offline' }

  const domain = domainErrorCode(error)
  if (domain) return { kind: 'domain', code: domain }

  const code = field(error, 'code')
  if (status === 401 || (typeof code === 'string' && NO_SESSION_CODES.has(code))) {
    return { kind: 'unauthorized' }
  }
  if (code === '42501') {
    // Only the server's own hint opens the code sheet (contract 1.7 D18, rule 13).
    const hint = StepUpHint.safeParse(field(error, 'hint'))
    return hint.success ? { kind: 'stepUp', hint: hint.data } : { kind: 'forbidden' }
  }
  if (code === OVERLAP_SQLSTATE) return { kind: 'overlap' }
  if (typeof code === 'string' && INVALID_SQLSTATES.has(code)) return { kind: 'invalid' }

  const hasSqlState = typeof code === 'string' && SQLSTATE.test(code)
  if (status === 0) return { kind: 'offline' }
  if (status !== undefined && GATEWAY_STATUSES.has(status) && !hasSqlState) {
    return { kind: 'offline' }
  }
  const message = field(error, 'message')
  if (!hasSqlState && typeof message === 'string') {
    const thrownName = /^(\w+):/.exec(message)?.[1]
    if (thrownName && NO_ANSWER_NAMES.has(thrownName)) return { kind: 'offline' }
  }
  return { kind: 'unknown' }
}

/** Domain codes whose text in the pro app differs from the booking page (`pro:errors.<code>`). */
export const PRO_DOMAIN_ERROR_TEXTS = ['AN001', 'AN020'] as const
type ProDomainErrorText = (typeof PRO_DOMAIN_ERROR_TEXTS)[number]

function hasProText(code: DomainErrorCode): code is ProDomainErrorText {
  return (PRO_DOMAIN_ERROR_TEXTS as readonly string[]).includes(code)
}

export type RpcFailureMessageKey =
  | 'pro:errors.offline'
  | 'pro:errors.forbidden'
  | 'pro:errors.overlap'
  | 'pro:errors.invalid'
  | 'pro:errors.gone'
  | 'pro:stepUp.failed'
  | 'pro:stepUp.cancelled'
  | `pro:errors.${ProDomainErrorText}`
  | `common:errors.${DomainErrorCode}`
  | 'common:errors.network'
  | 'common:errors.unknown'

/**
 * The i18n key of a failure. `write` (a mutation): offline = «Δεν αποθηκεύτηκε — χωρίς σύνδεση».
 * `read` (a query): offline = the common network text, shown with «Δοκίμασε ξανά».
 */
export function rpcFailureMessageKey(
  failure: RpcFailureInfo,
  mode: 'write' | 'read' = 'write',
): RpcFailureMessageKey {
  switch (failure.kind) {
    case 'offline':
      return mode === 'write' ? 'pro:errors.offline' : 'common:errors.network'
    case 'domain':
      return hasProText(failure.code)
        ? `pro:errors.${failure.code}`
        : `common:errors.${failure.code}`
    case 'stepUp':
      // A step-up failure that reached the screen: the retry after the code was refused again.
      return 'pro:stepUp.failed'
    case 'stepUpCancelled':
      return 'pro:stepUp.cancelled'
    case 'unauthorized':
    case 'forbidden':
      return 'pro:errors.forbidden'
    case 'overlap':
      return 'pro:errors.overlap'
    case 'invalid':
      return 'pro:errors.invalid'
    case 'gone':
      return 'pro:errors.gone'
    case 'unknown':
      return 'common:errors.unknown'
  }
}

/** Throws the classified failure of a supabase-js answer, if any. */
export function throwIfFailed(error: unknown, status: number | undefined): void {
  if (error) throw new RpcFailure(classifyRpcFailure(error, status), { cause: error })
}

/** The failure behind whatever a query or mutation rejected with. */
export function failureOf(error: unknown): RpcFailureInfo {
  return classifyRpcFailure(error)
}
