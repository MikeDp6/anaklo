import type { ZodMiniType } from 'zod/mini'
import { configValue } from './booking-config.ts'
import { DOMAIN_ERROR_HTTP_STATUS, type Log, type Rpc, type RpcError } from './booking-rpc.ts'
import { corsPreflight, withCors } from './cors.ts'
import { readBoundedBody } from './body-limit.ts'
import { domainErrorCode } from './errors.ts'
import { json } from './http.ts'
import type { FunctionErrorBody } from './member-schemas.ts'

/**
 * The plumbing of the member Edge Functions `invite-member` and `manage-factors` (contract 1.7
 * §3). Pure (ADR-0002 §3): Fetch API types and structural ports only; each `index.ts` wraps
 * supabase-js into the ports below and passes them in.
 *
 * The order that matters (plan 1.7, ADR-0009 §13): the critical check runs FIRST, as the caller
 * (their JWT, under RLS, `private.require_fresh_totp()` inside the `_impl`), and only after it
 * passed may the handler create the service-role client (`createAdmin`). The freshness rule is
 * never evaluated here (CLAUDE.md rule 13): the functions only pass the RPC's answer on.
 *
 * Every answer is CORS-wrapped (the pro app calls them directly with its JWT, ADR-0008 §10).
 * Errors have the PostgREST shape `{ code, message, hint }` (D12). Logs carry event names and
 * codes only: never emails, tokens or factor ids.
 */

/** Acts as the caller: their JWT on every request, so RLS and the SQL checks apply. */
export type CallerPort = {
  readonly rpc: Rpc
  /** GoTrue `getUser(jwt)`: the caller's id, or null when the session is not valid. */
  userId(): Promise<string | null>
}

export type CreateUserOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly exists: boolean; readonly status: number }

/** service_role: creates Auth users and calls the service_role RPCs. */
export type InviteAdminPort = {
  createUser(email: string): Promise<CreateUserOutcome>
  readonly rpc: Rpc
}

export type DeleteFactorOutcome =
  { readonly ok: true } | { readonly ok: false; readonly status: number }

/** service_role: the Auth admin API for factors. */
export type FactorsAdminPort = {
  deleteFactor(userId: string, factorId: string): Promise<DeleteFactorOutcome>
}

export interface MemberFunctionDeps<A> {
  caller(jwt: string): CallerPort
  /** Called at most once per request, and ONLY after the caller's RPC passed. */
  createAdmin(): A
  readonly log: Log
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/** Injected by the edge runtime, locally and hosted; nothing to set by hand. */
export const MEMBER_FUNCTION_ENV_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const
export type MemberFunctionEnv = Partial<
  Record<(typeof MEMBER_FUNCTION_ENV_NAMES)[number], string | undefined>
>

export type MemberFunctionConfig = {
  readonly url: string
  readonly anonKey: string
  readonly serviceRoleKey: string
}

/** The configuration, or the names that are missing (never a value). */
export function parseMemberFunctionEnv(
  env: MemberFunctionEnv,
): { ok: true; config: MemberFunctionConfig } | { ok: false; problems: string[] } {
  const url = configValue(env.SUPABASE_URL)
  const anonKey = configValue(env.SUPABASE_ANON_KEY)
  const serviceRoleKey = configValue(env.SUPABASE_SERVICE_ROLE_KEY)
  if (url !== null && anonKey !== null && serviceRoleKey !== null) {
    return { ok: true, config: { url, anonKey, serviceRoleKey } }
  }
  return {
    ok: false,
    problems: MEMBER_FUNCTION_ENV_NAMES.filter((name) => configValue(env[name]) === null).map(
      (name) => `${name}: missing`,
    ),
  }
}

// ---------------------------------------------------------------------------------------------
// Responses (D12)
// ---------------------------------------------------------------------------------------------

/** A flat `{ code, message, hint }` error with the JSON and no-store headers of `http.ts`. */
export function functionError(
  status: number,
  code: string,
  message: string,
  hint: string | null = null,
  headers?: HeadersInit,
): Response {
  const body: FunctionErrorBody = { code, message, hint }
  return json(body, headers === undefined ? { status } : { status, headers })
}

export function internalError(): Response {
  return functionError(500, 'internal', 'Internal error.')
}

export function notConfigured(): Response {
  return functionError(500, 'not_configured', 'The function is not configured.')
}

/** SQLSTATEs of a refused shape (the RPC's `22023`, a bad uuid `22P02`). */
const INVALID_ARGUMENT_SQLSTATES: ReadonlySet<string> = new Set(['22023', '22P02'])
/** PostgREST refused the JWT itself (expired between the gateway and the database). */
const JWT_REFUSED_CODES: ReadonlySet<string> = new Set(['PGRST301', 'PGRST303'])

function text(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The HTTP answer for an RPC error (D12). The RPC's own `{ code, message, hint }` passes through
 * unchanged, so a step-up hint reaches the pro app exactly as from PostgREST:
 * `42501` → 403 (with or without a hint), a domain error `P0001`/`AN0xx` → its status of
 * `DOMAIN_ERROR_HTTP_STATUS` (AN027 `last_factor` → 403), `22023`/`22P02` → 400, a refused JWT
 * → 401. Anything else (a missing function, a network failure) → 500 `internal`, with nothing of
 * the database's text.
 */
export function rpcErrorResponse(error: RpcError): Response {
  const code = text(error.code)
  const passThrough = (status: number) =>
    functionError(status, code ?? 'internal', text(error.message) ?? '', text(error.hint))

  if (code === '42501') return passThrough(403)
  const domain = domainErrorCode(error)
  if (domain !== null) return passThrough(DOMAIN_ERROR_HTTP_STATUS[domain])
  if (code !== null && INVALID_ARGUMENT_SQLSTATES.has(code)) return passThrough(400)
  if (code !== null && JWT_REFUSED_CODES.has(code)) return passThrough(401)
  return internalError()
}

// ---------------------------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------------------------

const BEARER = /^Bearer\s+(\S+)$/i

/** The JWT of `Authorization: Bearer <jwt>` (the gateway verified it: `verify_jwt = true`). */
export function bearerToken(req: Request): string | null {
  return BEARER.exec(req.headers.get('Authorization') ?? '')?.[1] ?? null
}

export type JsonBodyCheck<T> = { ok: true; data: T } | { ok: false; response: Response }

/**
 * A JSON body of at most `maxBytes` (never buffered beyond it, `body-limit.ts`: 413), parsed
 * with a `zod/mini` schema (400 `invalid_body`). Same rules as `parseJsonBody` in `http.ts`,
 * with the flat error shape of D12.
 */
export async function readJsonBody<T>(
  req: Request,
  schema: ZodMiniType<T>,
  maxBytes: number,
): Promise<JsonBodyCheck<T>> {
  const invalid = (message: string): JsonBodyCheck<T> => ({
    ok: false,
    response: functionError(400, 'invalid_body', message),
  })
  const read = await readBoundedBody(req, maxBytes)
  if (!read.ok) {
    return read.reason === 'too_large'
      ? {
          ok: false,
          response: functionError(413, 'payload_too_large', 'Request body is too large.'),
        }
      : invalid('Request body could not be read.')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
  } catch {
    return invalid('Request body is not valid JSON.')
  }
  const parsed = schema.safeParse(value)
  return parsed.success
    ? { ok: true, data: parsed.data }
    : invalid('Request body does not match the schema.')
}

export type MemberRequestCheck<T, A> =
  | { ok: true; jwt: string; body: T; deps: MemberFunctionDeps<A> }
  | { ok: false; response: Response }

/**
 * What both functions do before their own logic: method, configuration, bearer, body (contract
 * 1.7 §3.2 step 1). `OPTIONS` is answered by `serveMemberFunction` before this runs.
 */
export async function checkMemberRequest<T, A>(
  req: Request,
  deps: MemberFunctionDeps<A> | null,
  schema: ZodMiniType<T>,
  maxBytes: number,
): Promise<MemberRequestCheck<T, A>> {
  if (deps === null) return { ok: false, response: notConfigured() }
  if (req.method !== 'POST') {
    return {
      ok: false,
      response: functionError(405, 'method_not_allowed', 'Method not allowed.', null, {
        Allow: 'POST, OPTIONS',
      }),
    }
  }
  const jwt = bearerToken(req)
  if (jwt === null) {
    return { ok: false, response: functionError(401, 'unauthorized', 'Missing bearer token.') }
  }
  const body = await readJsonBody(req, schema, maxBytes)
  if (!body.ok) return body
  return { ok: true, jwt, body: body.data, deps }
}

/** `OPTIONS` → the preflight; everything else through `handle`, CORS-wrapped. */
export async function serveMemberFunction(
  req: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  if (req.method === 'OPTIONS') return corsPreflight()
  return withCors(await handle())
}

/** One RPC call; a thrown error (network) becomes an `RpcError` without a SQLSTATE (→ 500). */
export async function callAs(
  rpc: Rpc,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ data: unknown; error: RpcError | null }> {
  try {
    return await rpc(fn, args)
  } catch {
    return { data: null, error: { code: null, message: 'rpc threw', hint: null } }
  }
}

// ---------------------------------------------------------------------------------------------
// Ports over supabase-js (structural, so this file needs no npm import)
// ---------------------------------------------------------------------------------------------

/** The fields of an `AuthError` the ports read. */
export type AuthErrorLike = {
  readonly code?: string | null | undefined
  readonly status?: number | null | undefined
}

type AuthResult<T> = { data: T; error: AuthErrorLike | null }

/** The part of `supabase.auth` the caller port uses. */
export interface UserAuthLike {
  getUser(jwt: string): Promise<AuthResult<{ user: { id: string } | null }>>
}

/** The part of `supabase.auth.admin` the admin ports use. */
export interface AdminAuthLike {
  createUser(attributes: {
    email: string
    email_confirm: boolean
  }): Promise<AuthResult<{ user: { id: string } | null }>>
  readonly mfa: {
    deleteFactor(params: { id: string; userId: string }): Promise<{ error: AuthErrorLike | null }>
  }
}

export function callerPort(auth: UserAuthLike, jwt: string, rpc: Rpc): CallerPort {
  return {
    rpc,
    async userId() {
      try {
        const { data, error } = await auth.getUser(jwt)
        return error === null ? (data.user?.id ?? null) : null
      } catch {
        return null
      }
    },
  }
}

/**
 * `auth.admin.createUser` with a confirmed email and nothing else: no password, no invite link
 * (it would open a session in Safari, outside the installed app), no email sent (ADR-0009 §9).
 * The new member signs in with an email code. `email_exists` (422) → reuse the user.
 */
export function inviteAdminPort(
  admin: Pick<AdminAuthLike, 'createUser'>,
  rpc: Rpc,
): InviteAdminPort {
  return {
    rpc,
    async createUser(email) {
      try {
        const { data, error } = await admin.createUser({ email, email_confirm: true })
        if (error === null && data.user !== null) return { ok: true, userId: data.user.id }
        return {
          ok: false,
          exists: error?.code === 'email_exists',
          status: error?.status ?? 0,
        }
      } catch {
        return { ok: false, exists: false, status: 0 }
      }
    },
  }
}

/** `auth.admin.mfa.deleteFactor`: the only way the app removes a verified factor (ADR-0009 §21). */
export function factorsAdminPort(admin: Pick<AdminAuthLike, 'mfa'>): FactorsAdminPort {
  return {
    async deleteFactor(userId, factorId) {
      try {
        const { error } = await admin.mfa.deleteFactor({ id: factorId, userId })
        return error === null ? { ok: true } : { ok: false, status: error.status ?? 0 }
      } catch {
        return { ok: false, status: 0 }
      }
    },
  }
}
