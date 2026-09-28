import { readBoundedBody } from '../supabase/functions/_shared/body-limit.ts'
import {
  PROXY_HEADERS,
  isAllowedProxyRoute,
  isUuid,
} from '../supabase/functions/_shared/proxy-contract.ts'
import { readTrustedDeviceToken, trustedDeviceSetCookie } from './cookies.ts'

/**
 * The hardened same-origin `/api` proxy (ADR-0008 §3–4). One pure function, used by the
 * Cloudflare Worker and by the Vite dev/preview middleware, so e2e runs the production path.
 */

export type ProxyEnv = {
  SUPABASE_URL: string
  SUPABASE_PUBLISHABLE_KEY: string
  PROXY_SECRET: string
  /** Only `local` relaxes the trusted-device cookie; anything else (or nothing) is deployed. */
  APP_ENV?: string | undefined
  /** Supabase region, forwarded as `x-region` so Edge Functions run next to the database. */
  SUPABASE_REGION?: string | undefined
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type ProxyDeps = {
  fetch: FetchLike
  /** The client's IP as the platform saw it (`CF-Connecting-IP`, or the dev socket). */
  clientIp: string | null | undefined
}

/** Anchored with the trailing slash: `/api-barber` is a booking slug, never the proxy. */
export const API_PREFIX = '/api/'

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith(API_PREFIX)
}

/**
 * Larger request bodies are refused before anything reaches Supabase, and never held in memory:
 * a body without Content-Length (chunked, HTTP/2) is cut off as soon as it passes the cap.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * Client request headers forwarded upstream. Everything else is dropped by construction,
 * including every client `x-anaklo-*`, `x-forwarded-*`, `x-real-ip`, `forwarded`, `cf-*`,
 * `cookie`, `authorization`, `apikey` and `host`.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'accept-profile',
  'content-profile',
  'content-type',
  'prefer',
] as const

/** Upstream response headers never passed to the browser (the proxy sets its own). */
const DROPPED_RESPONSE_HEADERS = new Set([
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'set-cookie2',
  'transfer-encoding',
])

const IP_ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/

function securityHeaders(headers: Headers): Headers {
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

/** The proxy's own errors, in the functions' shape (`_shared/http.ts`): `{ error: { code, message } }`. */
const PROXY_ERRORS = {
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  invalid_body: 'Invalid request body.',
  payload_too_large: 'Request body too large.',
  upstream_unavailable: 'Upstream unavailable.',
  upstream_invalid: 'Invalid upstream response.',
} as const

function jsonError(
  status: number,
  code: keyof typeof PROXY_ERRORS,
  extra?: Record<string, string>,
): Response {
  const headers = securityHeaders(new Headers({ 'Content-Type': 'application/json', ...extra }))
  const body = { error: { code, message: PROXY_ERRORS[code] } }
  return new Response(JSON.stringify(body), { status, headers })
}

function upstreamBase(supabaseUrl: string): string {
  return supabaseUrl.replace(/\/+$/, '')
}

function buildUpstreamHeaders(
  request: Request,
  env: ProxyEnv,
  deps: ProxyDeps,
  businessId: string | null,
): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('apikey', env.SUPABASE_PUBLISHABLE_KEY)
  if (env.PROXY_SECRET) headers.set(PROXY_HEADERS.secret, env.PROXY_SECRET)
  if (deps.clientIp && IP_ADDRESS.test(deps.clientIp)) {
    headers.set(PROXY_HEADERS.clientIp, deps.clientIp)
  }
  if (env.SUPABASE_REGION) headers.set('x-region', env.SUPABASE_REGION)
  if (businessId) {
    headers.set(PROXY_HEADERS.business, businessId)
    const token = readTrustedDeviceToken(request.headers.get('cookie'), businessId, env.APP_ENV)
    if (token) headers.set(PROXY_HEADERS.trustedDevice, token)
  }
  return headers
}

type BodyRead = { ok: true; body: ArrayBuffer | null } | { ok: false; response: Response }

async function readBody(request: Request): Promise<BodyRead> {
  if (request.method !== 'POST') return { ok: true, body: null }
  const read = await readBoundedBody(request, MAX_REQUEST_BODY_BYTES)
  if (read.ok) return { ok: true, body: read.bytes.buffer }
  return {
    ok: false,
    response:
      read.reason === 'too_large'
        ? jsonError(413, 'payload_too_large')
        : jsonError(400, 'invalid_body'),
  }
}

function buildResponse(upstream: Response, env: ProxyEnv, businessId: string | null): Response {
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (DROPPED_RESPONSE_HEADERS.has(lower)) return
    if (lower.startsWith('x-anaklo-') || lower.startsWith('access-control-')) return
    headers.append(name, value)
  })
  const token = upstream.headers.get(PROXY_HEADERS.setTrustedDevice)
  if (token !== null && businessId) {
    const cookie = trustedDeviceSetCookie(businessId, token.trim(), env.APP_ENV)
    if (cookie) headers.append('Set-Cookie', cookie)
  }
  securityHeaders(headers)
  const hasBody = upstream.status !== 204 && upstream.status !== 304
  return new Response(hasBody ? upstream.body : null, { status: upstream.status, headers })
}

/**
 * Proxies one `/api/*` request to Supabase. Refuses (without calling upstream) any path or
 * method outside the contract's allow-list. The business header is read before the client's
 * headers are discarded and is the only thing that selects a trusted-device cookie.
 */
export async function handleApiRequest(
  request: Request,
  env: ProxyEnv,
  deps: ProxyDeps,
): Promise<Response> {
  const url = new URL(request.url)
  if (!isApiPath(url.pathname)) return jsonError(404, 'not_found')
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonError(405, 'method_not_allowed', { Allow: 'GET, POST' })
  }
  const path = url.pathname.slice(API_PREFIX.length - 1)
  if (!isAllowedProxyRoute(request.method, path)) return jsonError(404, 'not_found')

  const declaredBusiness = request.headers.get(PROXY_HEADERS.business)
  const businessId = isUuid(declaredBusiness) ? declaredBusiness.toLowerCase() : null

  const body = await readBody(request)
  if (!body.ok) return body.response

  let upstream: Response
  try {
    upstream = await deps.fetch(`${upstreamBase(env.SUPABASE_URL)}${path}${url.search}`, {
      method: request.method,
      headers: buildUpstreamHeaders(request, env, deps, businessId),
      body: body.body,
      redirect: 'manual',
    })
  } catch {
    return jsonError(502, 'upstream_unavailable')
  }
  if (upstream.status < 200 || upstream.status > 599) return jsonError(502, 'upstream_invalid')
  return buildResponse(upstream, env, businessId)
}
