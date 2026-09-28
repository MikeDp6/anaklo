import type { ZodMiniType } from 'zod/mini'
import { readBoundedBody } from './body-limit.ts'
import { PROXY_HEADERS } from './proxy-contract.ts'

/**
 * HTTP helpers for the Edge Functions behind the `/api` proxy (ADR-0008 §3): `health`,
 * `spike-td`, and later `public-booking` and `manage`. Pure (ADR-0002 §3): Fetch API types
 * only, no Deno APIs. Each `index.ts` reads `PROXY_SECRET` from `Deno.env` and passes it in.
 *
 * Every error has one shape, `{ error: { code, message } }`. The `message` is for developers
 * and logs; the UI never shows it and maps `code` through i18n instead (CLAUDE.md rule 8).
 */

export type ErrorBody = { error: { code: string; message: string } }

/**
 * A shorter configured secret is treated as missing: it would be guessable. Generated secrets
 * (`npm run secrets:dev`) are much longer; the local default in `.env.example` has 32 chars.
 */
export const MIN_PROXY_SECRET_LENGTH = 16

/** Same cap as the proxy (`edge/api-proxy.ts`); larger bodies never reach a schema. */
export const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * The Supabase CLI leaves an unresolved `env(NAME)` in `config.toml` as that literal string,
 * so a missing local `PROXY_SECRET` would otherwise become a public, well-known secret.
 */
const UNRESOLVED_ENV_REFERENCE = /^env\(.*\)$/

/** Same shape check as the proxy applies before it forwards `CF-Connecting-IP`. */
const IP_ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return new Response(JSON.stringify(body), { ...init, headers })
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  const body: ErrorBody = { error: { code, message } }
  return json(body, headers === undefined ? { status } : { status, headers })
}

/**
 * Compares two strings in time that depends only on the length of `expected` (the secret),
 * never on where the first difference is. Pure TS, so it runs the same in Deno and Vitest.
 */
export function constantTimeEqual(provided: string, expected: string): boolean {
  let diff = provided.length ^ expected.length
  for (let i = 0; i < expected.length; i++) {
    // Past the end of `provided` charCodeAt gives NaN; `| 0` turns it into 0. The length
    // difference above has already made the result false in that case.
    diff |= (provided.charCodeAt(i) | 0) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function configuredSecret(secret: string | null | undefined): string | null {
  if (typeof secret !== 'string') return null
  const value = secret.trim()
  if (value.length < MIN_PROXY_SECRET_LENGTH || UNRESOLVED_ENV_REFERENCE.test(value)) return null
  return value
}

/** The client's IP as the proxy saw it; never `x-forwarded-for` or anything else the client set. */
function readClientIp(headers: Headers): string | null {
  const value = headers.get(PROXY_HEADERS.clientIp)?.trim() ?? ''
  return IP_ADDRESS.test(value) ? value : null
}

export type ProxyCheck = { ok: true; clientIp: string | null } | { ok: false; response: Response }

/**
 * The trust chain of ADR-0006 §6: only the proxy knows `PROXY_SECRET`, so only requests that
 * came through it are accepted, and only then is the client IP header believed.
 * A missing, empty or placeholder secret is a deployment error: 500, and nothing is accepted.
 */
export function requireProxy(req: Request, secret: string | null | undefined): ProxyCheck {
  const expected = configuredSecret(secret)
  if (expected === null) {
    return {
      ok: false,
      response: errorResponse('proxy_not_configured', 'PROXY_SECRET is not configured.', 500),
    }
  }
  const provided = req.headers.get(PROXY_HEADERS.secret)
  if (provided === null || !constantTimeEqual(provided, expected)) {
    return { ok: false, response: errorResponse('forbidden', 'Forbidden.', 403) }
  }
  return { ok: true, clientIp: readClientIp(req.headers) }
}

export type MethodCheck = { ok: true } | { ok: false; response: Response }

export function requireMethod(req: Request, ...allowed: readonly string[]): MethodCheck {
  if (allowed.includes(req.method)) return { ok: true }
  return {
    ok: false,
    response: errorResponse('method_not_allowed', 'Method not allowed.', 405, {
      Allow: allowed.join(', '),
    }),
  }
}

export type BodyCheck<T> = { ok: true; data: T } | { ok: false; response: Response }

function invalidBody(message: string): { ok: false; response: Response } {
  return { ok: false, response: errorResponse('invalid_body', message, 400) }
}

/**
 * Reads a JSON body of at most `maxBytes` and validates it with a `zod/mini` schema: 400 if not.
 * A body over the cap is never buffered, with or without Content-Length (`body-limit.ts`): 413.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: ZodMiniType<T>,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<BodyCheck<T>> {
  const read = await readBoundedBody(req, maxBytes)
  if (!read.ok) {
    return read.reason === 'too_large'
      ? {
          ok: false,
          response: errorResponse('payload_too_large', 'Request body is too large.', 413),
        }
      : invalidBody('Request body could not be read.')
  }

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
  } catch {
    return invalidBody('Request body is not valid JSON.')
  }

  const parsed = schema.safeParse(value)
  if (!parsed.success) return invalidBody('Request body does not match the schema.')
  return { ok: true, data: parsed.data }
}
