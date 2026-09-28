import type { ZodMiniType } from 'zod/mini'
import { domainErrorCode } from '@fn-shared/errors.ts'

/**
 * Calls the same-origin `/api` proxy (ADR-0005/0008) with `fetch`, so the booking page does not
 * ship supabase-js. The proxy adds the publishable key, so the page sends none. Every response
 * is validated with Zod.
 */

/**
 * `code` is what the UI maps through i18n: a domain code (`AN0xx`, from a PostgREST error or an
 * Edge Function body), another code of the functions/proxy (`internal`, `not_found`, …),
 * `network` when no answer arrived, or `http_<status>` when the body had no code.
 */
export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PublicApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `{ error: { code } }` (functions, proxy) or `{ code: 'P0001', message: 'AN0xx' }` (PostgREST). */
export function errorCodeOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    const nested = body.error
    if (isRecord(nested) && typeof nested.code === 'string' && nested.code !== '') {
      return nested.code
    }
    const domain = domainErrorCode(body)
    if (domain) return domain
  }
  return `http_${status}`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

export async function postPublicApi<T>(
  path: string,
  body: unknown,
  schema: ZodMiniType<T>,
  options: { headers?: Record<string, string>; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new PublicApiError(0, 'network', `${path} did not answer`)
  }
  const json = await readJson(response)
  if (!response.ok) {
    const code = errorCodeOf(json, response.status)
    throw new PublicApiError(response.status, code, `${path} failed with ${code}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new PublicApiError(response.status, 'invalid_response', path)
  return parsed.data
}

export function callPublicRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: ZodMiniType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return postPublicApi(`/rest/v1/rpc/${encodeURIComponent(name)}`, args, schema, { signal })
}

/** The i18n-able code of anything a call threw (aborts excluded by the caller). */
export function apiErrorCode(error: unknown): string {
  return error instanceof PublicApiError ? error.code : 'unexpected'
}
