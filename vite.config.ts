import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import {
  MAX_REQUEST_BODY_BYTES,
  handleApiRequest,
  isApiPath,
  type ProxyEnv,
} from './edge/api-proxy.ts'
import { lookupBookingShell, lookupShortLink } from './edge/booking-shell.ts'
import { injectBookingShell } from './edge/inject.ts'
import { findServerKeys } from './scripts/lib/server-keys.mjs'
import { resolveBookingRoute } from './src/app/booking/route.ts'

const PRO_APP_PREFIX = '/app'

/**
 * Two HTML entries (ADR-0002): the booking page (`index.html`) and the pro app (`app/index.html`).
 * In dev/preview, every `/app/*` route without a file extension is served the pro app shell.
 */
function isProAppRoute(url: string): boolean {
  const path = url.split('?')[0] ?? ''
  const isUnderPrefix = path === PRO_APP_PREFIX || path.startsWith(`${PRO_APP_PREFIX}/`)
  const lastSegment = path.split('/').pop() ?? ''
  return isUnderPrefix && !lastSegment.includes('.')
}

const proAppFallback: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.url && isProAppRoute(req.url)) req.url = `${PRO_APP_PREFIX}/index.html`
  next()
}

function proAppShell(): Plugin {
  return {
    name: 'anaklo:pro-app-shell',
    configureServer(server) {
      server.middlewares.use(proAppFallback)
    },
    configurePreviewServer(server) {
      server.middlewares.use(proAppFallback)
    },
  }
}

/**
 * The proxy settings of the dev/preview server, the same the Worker gets as vars and secrets
 * (ADR-0008 §6). Read without a prefix, but only used inside this server: nothing here is
 * `define`d, so non-VITE_ values (PROXY_SECRET) never reach the client bundle.
 */
function readProxyEnv(mode: string): ProxyEnv {
  const all = loadEnv(mode, process.cwd(), '')
  return {
    SUPABASE_URL: all.VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: all.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
    PROXY_SECRET: all.PROXY_SECRET ?? '',
    APP_ENV: all.APP_ENV || undefined,
    SUPABASE_REGION: all.SUPABASE_REGION || undefined,
  }
}

/**
 * One byte more than the proxy accepts: enough for `handleApiRequest` to answer 413 on the same
 * path as the Worker, whatever the client declared (or did not declare) as Content-Length.
 */
const NODE_BODY_KEEP_BYTES = MAX_REQUEST_BODY_BYTES + 1

/**
 * The request body, but never more than `limit` bytes in memory. The rest of a larger (or
 * endless) upload is drained and dropped, not buffered; the socket stays usable for the answer.
 */
function readNodeBody(req: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let kept = 0
    const finish = () => {
      cleanUp()
      resolve(new Uint8Array(Buffer.concat(chunks, kept)))
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const room = limit - kept
      chunks.push(buffer.length > room ? buffer.subarray(0, room) : buffer)
      kept += Math.min(room, buffer.length)
      if (kept < limit) return
      finish()
      req.resume()
    }
    const onError = (error: Error) => {
      cleanUp()
      reject(error)
    }
    // The client went away before the end of the body.
    const onClose = () => onError(new Error('request closed'))
    const cleanUp = () => {
      req.off('data', onData)
      req.off('end', finish)
      req.off('error', onError)
      req.off('close', onClose)
    }
    req.on('data', onData)
    req.once('end', finish)
    req.once('error', onError)
    req.once('close', onClose)
  })
}

async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  const method = req.method ?? 'GET'
  const body =
    method === 'GET' || method === 'HEAD' ? null : await readNodeBody(req, NODE_BODY_KEEP_BYTES)
  // Only the path and query matter to the proxy; the origin is a placeholder.
  return new Request(new URL(req.url ?? '/', 'http://localhost'), { method, headers, body })
}

async function sendFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') res.setHeader(name, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies)
  res.end(Buffer.from(await response.arrayBuffer()))
}

/** `/api/*` through the same `handleApiRequest` as the Worker, instead of Vite's http-proxy. */
function apiProxy(env: ProxyEnv): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!isApiPath((req.url ?? '').split('?')[0] ?? '')) {
      next()
      return
    }
    const handle = async () => {
      let request: Request
      try {
        request = await toFetchRequest(req)
      } catch {
        res.statusCode = 400
        res.end()
        return
      }
      const response = await handleApiRequest(request, env, {
        fetch: (input, init) => fetch(input, init),
        clientIp: req.socket.remoteAddress,
      })
      await sendFetchResponse(res, response)
    }
    handle().catch(next)
  }
  return {
    name: 'anaklo:api-proxy',
    configureServer(server) {
      if (!env.PROXY_SECRET && !process.env.VITEST) {
        server.config.logger.warn(
          'PROXY_SECRET is not set (.env.local): Edge Functions behind /api will refuse requests.',
        )
      }
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

/**
 * Dev only, the Worker's page routes on the same modules (ADR-0008 §5, contract 1.3 §8):
 * - `/<slug>` gets the server-side injection (catalogue, title, Open Graph), so Playwright sees
 *   the production HTML. Unknown slugs keep status 200 here (the Worker answers 404); the page
 *   shows its not-found message either way.
 * - `/r/<code>` redirects (302, no-store) to `/<slug>` when the database answers; otherwise the
 *   page resolves the code itself.
 * - `/m/<token>` gets `Referrer-Policy: no-referrer` like the Worker (Vite's own HTML handler then
 *   sends `Cache-Control: no-cache` in dev; the Worker sends `no-store`).
 */
function bookingShell(env: ProxyEnv): Plugin {
  const routes: Connect.NextHandleFunction = (req, res, next) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (path.startsWith('/m/')) {
      res.setHeader('Referrer-Policy', 'no-referrer')
      return next()
    }
    const route = resolveBookingRoute(path)
    if (route.kind !== 'short-link') return next()
    lookupShortLink(route.code, env, (input, init) => fetch(input, init))
      .then((lookup) => {
        if (lookup.kind !== 'found') return next()
        res.statusCode = 302
        res.setHeader('Location', `/${lookup.slug}`)
        res.setHeader('Cache-Control', 'no-store')
        res.end()
      })
      .catch(next)
  }
  return {
    name: 'anaklo:booking-shell',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(routes)
    },
    async transformIndexHtml(html, ctx) {
      if (!ctx.server || ctx.path !== '/index.html' || !ctx.originalUrl) return html
      const route = resolveBookingRoute(new URL(ctx.originalUrl, 'http://localhost').pathname)
      if (route.kind !== 'business') return html
      const origin = ctx.server.resolvedUrls?.local[0]?.replace(/\/+$/, '')
      const lookup = await lookupBookingShell(
        route.slug,
        env,
        (input, init) => fetch(input, init),
        origin,
      )
      return injectBookingShell(html, lookup.kind === 'found' ? lookup.data : null)
    },
  }
}

/**
 * Every VITE_* value ends up in the public bundle. Refuse to build if one of them is a server
 * key (ADR-0005), with the same detector as scripts/check-secrets.mjs, which scans the output
 * after the build.
 */
function assertNoServerKeys(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    const [key] = findServerKeys(value)
    if (key) throw new Error(`${name} contains ${key}`)
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') assertNoServerKeys(loadEnv(mode, process.cwd(), 'VITE_'))
  const proxyEnv = readProxyEnv(mode)

  return {
    plugins: [react(), apiProxy(proxyEnv), bookingShell(proxyEnv), proAppShell()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@fn-shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
      },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: {
      target: 'es2022',
      manifest: true,
      // Maps are generated for Sentry but never referenced from the bundles. They are deleted
      // from dist before every Worker deploy, and public/.assetsignore keeps them out as well.
      sourcemap: 'hidden',
      rolldownOptions: {
        input: {
          booking: fileURLToPath(new URL('./index.html', import.meta.url)),
          pro: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        },
      },
    },
  }
})
