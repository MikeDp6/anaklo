import { DOMAIN_ERRORS, domainErrorCode, type DomainErrorCode } from './errors.ts'
import { errorResponse } from './http.ts'

/**
 * The database side of `public-booking` and `manage` (contract 1.3 §3). Pure (ADR-0002 §3):
 * `index.ts` wraps the service-role supabase-js client in an `Rpc` (only `.rpc()`, never
 * `.from()`), so the handlers and `send.ts` run the same in Deno and in Vitest with fakes.
 */

export type RpcError = {
  readonly code?: string | null
  readonly message?: string | null
  /** The domain error's name (PostgREST forwards the `hint`); informational only. */
  readonly hint?: string | null
}

export type RpcResult = { data: unknown; error: RpcError | null }

export type Rpc = (fn: string, args: Readonly<Record<string, unknown>>) => Promise<RpcResult>

/** A value a log line may carry: codes, ids, counts. Never phones, codes, tokens or names. */
export type LogValue = string | number | boolean | null | readonly string[]
export type Log = (event: string, fields: Readonly<Record<string, LogValue>>) => void

/**
 * HTTP status of every domain error (contract 1.3 §2.1). Typed against `DOMAIN_ERRORS`, so a
 * new code does not compile until it has a status here. AN005/AN006 are raised for staff only;
 * AN010–AN012 are emitted by `public-booking` itself (from `otp_verify`'s result). AN021–AN023
 * (0006) come only from the pro app's RPCs through PostgREST; their status here is for
 * completeness (a conflict for AN021, like AN001/AN004).
 */
export const DOMAIN_ERROR_HTTP_STATUS = {
  AN001: 409,
  AN002: 422,
  AN003: 422,
  AN004: 409,
  AN005: 422,
  AN006: 422,
  AN007: 422,
  AN008: 422,
  AN009: 404,
  AN010: 422,
  AN011: 422,
  AN012: 422,
  AN013: 429,
  AN014: 403,
  AN015: 403,
  AN016: 422,
  AN017: 503,
  AN018: 422,
  AN019: 429,
  AN020: 422,
  AN021: 409,
  AN022: 422,
  AN023: 422,
  // 0009: the members/identity RPCs (PostgREST) and the Edge Functions invite-member and
  // manage-factors (contract 1.7 §2.9, D12). AN027 is 403: the plan's «403 without a step-up hint»
  // for the last device.
  AN024: 409,
  AN025: 409,
  AN026: 409,
  AN027: 403,
  AN028: 409,
  AN029: 409,
  AN030: 404,
  AN031: 409,
  // 0010: erase_client with an upcoming appointment; a client merged or erased meanwhile
  // (contract 1.8 §2.8).
  AN032: 409,
  AN033: 409,
  // 0012: authorize_factor_change('add') while the account's enrolment is blocked until Nous resets
  // it (contract 1.9b §2.4, G2).
  AN034: 403,
} as const satisfies Record<DomainErrorCode, number>

/** `{ error: { code: 'AN0xx', message: <name> } }` with the status of §2.1. */
export function domainErrorResponse(code: DomainErrorCode): Response {
  return errorResponse(code, DOMAIN_ERRORS[code], DOMAIN_ERROR_HTTP_STATUS[code])
}

export function internalErrorResponse(): Response {
  return errorResponse('internal', 'Internal error.', 500)
}

export type RpcOutcome =
  | { ok: true; data: unknown }
  | { ok: false; code: DomainErrorCode | 'internal'; response: Response }

/**
 * Calls one RPC. A domain error becomes its HTTP answer (§2.1); anything else (network,
 * permission, missing Vault key `55000`, `22023`) becomes 500 `internal`, logged with the
 * SQLSTATE only.
 */
export async function callRpc(
  rpc: Rpc,
  log: Log,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<RpcOutcome> {
  let result: RpcResult
  try {
    result = await rpc(fn, args)
  } catch {
    log('rpc_failed', { fn, sqlstate: null, reason: 'exception' })
    return { ok: false, code: 'internal', response: internalErrorResponse() }
  }
  if (result.error === null) return { ok: true, data: result.data }

  const code = domainErrorCode(result.error)
  if (code !== null) {
    log('rpc_domain_error', { fn, code })
    return { ok: false, code, response: domainErrorResponse(code) }
  }
  log('rpc_failed', { fn, sqlstate: result.error.code ?? null })
  return { ok: false, code: 'internal', response: internalErrorResponse() }
}

/** One JSON line per event on stdout (the platform's function logs). */
export function consoleLog(scope: string): Log {
  return (event, fields) => {
    console.log(JSON.stringify({ function: scope, event, ...fields }))
  }
}
