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
 * AN010–AN012 are emitted by `public-booking` itself (from `otp_verify`'s result).
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
