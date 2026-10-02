import { resolveBookingRoute } from '../src/app/booking/route.ts'
import { handleApiRequest, isApiPath, type FetchLike, type ProxyEnv } from './api-proxy.ts'
import { lookupBookingShell, lookupShortLink } from './booking-shell.ts'
import { injectBookingShell, type BookingShellData } from './inject.ts'

/**
 * The Cloudflare Worker behind dev.anaklo.gr (ADR-0008). It only wires the pure modules:
 * the `/api` proxy, the booking shell injection and the routing table of ADR-0008 §2.
 * Static files are normally served by the assets layer before this code runs.
 */

/** The part of the `ASSETS` binding the Worker uses (a `Fetcher` satisfies it). */
export type AssetsBinding = { fetch(input: Request | string): Promise<Response> }

export interface Env extends ProxyEnv {
  ASSETS: AssetsBinding
}

const BOOKING_SHELL = '/index.html'
const PRO_APP_SHELL = '/app/index.html'
const PRO_APP_PREFIX = '/app'
/** Token pages (the manage link, step 1.3): never cached, never leaked through Referer. */
const TOKEN_PAGE_PREFIX = '/m/'

export type WorkerRoute =
  | { kind: 'api' }
  | { kind: 'asset' }
  | { kind: 'pro-app' }
  | { kind: 'token-page' }
  | { kind: 'landing' }
  | { kind: 'business'; slug: string }
  | { kind: 'manage'; token: string }
  | { kind: 'short-link'; code: string }
  | { kind: 'not-found' }

export function resolveWorkerRoute(pathname: string): WorkerRoute {
  if (isApiPath(pathname)) return { kind: 'api' }
  const lastSegment = pathname.split('/').pop() ?? ''
  if (lastSegment.includes('.')) return { kind: 'asset' }
  if (pathname === PRO_APP_PREFIX || pathname.startsWith(`${PRO_APP_PREFIX}/`)) {
    return { kind: 'pro-app' }
  }
  if (pathname.startsWith(TOKEN_PAGE_PREFIX)) return { kind: 'token-page' }
  return resolveBookingRoute(pathname)
}

type ShellOptions = {
  status?: number
  referrerPolicy?: 'no-referrer' | 'strict-origin-when-cross-origin'
  cacheControl?: string
  frameOptions?: 'DENY'
  inject?: BookingShellData | null
}

async function serveShell(
  request: Request,
  env: Env,
  shellPath: string,
  options: ShellOptions = {},
): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL(shellPath, request.url).toString())
  if (!asset.ok) return asset
  const html = injectBookingShell(await asset.text(), options.inject ?? null)
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': options.cacheControl ?? 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': options.referrerPolicy ?? 'strict-origin-when-cross-origin',
  })
  if (options.frameOptions) headers.set('X-Frame-Options', options.frameOptions)
  const body = request.method === 'HEAD' ? null : html
  return new Response(body, { status: options.status ?? 200, headers })
}

/**
 * A same-site redirect that no cache keeps: a code may later point elsewhere, and a former slug
 * (301) must never be remembered by a browser, or a later change back could loop (contract 1.7 D7).
 */
function redirect(location: string, status: 301 | 302 = 302): Response {
  return new Response(null, {
    status,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  })
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
  })
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: FetchLike,
): Promise<Response> {
  const url = new URL(request.url)
  const route = resolveWorkerRoute(url.pathname)

  if (route.kind === 'api') {
    const clientIp = request.headers.get('CF-Connecting-IP')
    return handleApiRequest(request, env, { fetch: fetchImpl, clientIp })
  }
  if (route.kind === 'asset') return env.ASSETS.fetch(request)
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed()

  switch (route.kind) {
    case 'pro-app':
      return serveShell(request, env, PRO_APP_SHELL, { frameOptions: 'DENY' })
    case 'token-page':
    case 'manage':
      return serveShell(request, env, BOOKING_SHELL, {
        referrerPolicy: 'no-referrer',
        cacheControl: 'no-store',
      })
    case 'landing':
      return serveShell(request, env, BOOKING_SHELL)
    case 'not-found':
      return serveShell(request, env, BOOKING_SHELL, { status: 404 })
    case 'short-link': {
      // `/r/<code>` from an SMS: straight to the booking page when the database answers.
      const lookup = await lookupShortLink(route.code, env, fetchImpl)
      if (lookup.kind === 'found') return redirect(`/${lookup.slug}`)
      if (lookup.kind === 'not-found') {
        return serveShell(request, env, BOOKING_SHELL, { status: 404, cacheControl: 'no-store' })
      }
      // Supabase did not answer: the page resolves the code through /api itself.
      return serveShell(request, env, BOOKING_SHELL, { cacheControl: 'no-store' })
    }
    case 'business': {
      const lookup = await lookupBookingShell(route.slug, env, fetchImpl, url.origin)
      // A former slug (contract 1.7 §4): links already sent keep working, at the new address.
      if (lookup.kind === 'moved') return redirect(`/${lookup.slug}${url.search}`, 301)
      if (lookup.kind === 'not-found')
        return serveShell(request, env, BOOKING_SHELL, { status: 404 })
      // Supabase did not answer: the plain shell, and the page loads the catalogue itself.
      const inject = lookup.kind === 'found' ? lookup.data : null
      return serveShell(request, env, BOOKING_SHELL, { inject })
    }
  }
}

export default {
  fetch(request, env) {
    // Wrapped: workerd throws "Illegal invocation" when `fetch` is called detached.
    return handleRequest(request, env, (input, init) => fetch(input, init))
  },
} satisfies ExportedHandler<Env>
