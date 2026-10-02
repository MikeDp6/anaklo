import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { FunctionErrorBody } from '@fn-shared/member-schemas.ts'
import { classifyRpcFailure, RpcFailure } from './rpcError'

/**
 * Turns what `supabase.functions.invoke` returned as `error` into the same `RpcFailure` an RPC
 * throws (contract 1.7 §6.6, D12). The member Edge Functions answer errors in the PostgREST shape
 * `{ code, message, hint }`, so a 403 `{ code: '42501', hint: 'fresh_totp_required' }` from
 * `invite-member` or `manage-factors` is a `stepUp` exactly like the RPC's own error, and
 * `withStepUp` opens the code sheet and retries once for both.
 *
 * - `FunctionsHttpError` (a non-2xx answer): the status and the body of `error.context`.
 * - `FunctionsFetchError` (no answer): `offline`.
 * - anything else (the relay, an unexpected throw): `unknown`.
 * No error → nothing thrown.
 */
export async function throwIfFunctionFailed(error: unknown): Promise<void> {
  if (error === null || error === undefined) return
  if (error instanceof FunctionsFetchError) {
    throw new RpcFailure({ kind: 'offline' }, { cause: error })
  }
  if (error instanceof FunctionsHttpError) {
    const response: unknown = error.context
    const status = response instanceof Response ? response.status : undefined
    const body = response instanceof Response ? await readBody(response) : null
    throw new RpcFailure(classifyRpcFailure(body ?? {}, status), { cause: error })
  }
  throw new RpcFailure({ kind: 'unknown' }, { cause: error })
}

interface ErrorBody {
  readonly code: string
  readonly message: string
  readonly hint: string | null
}

/** The flat `{ code, message, hint }` body, or null when the answer has another shape. */
async function readBody(response: Response): Promise<ErrorBody | null> {
  try {
    const parsed = FunctionErrorBody.safeParse(await response.clone().json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
