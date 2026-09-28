// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './api-proxy.ts'
import { handleRequest, resolveWorkerRoute, type AssetsBinding, type Env } from './worker.ts'

const BOOKING_SHELL = `<!doctype html>
<html lang="el">
  <head>
    <meta name="theme-color" content="#1f3a5f" />
    <title>Anaklo</title>
  </head>
  <body><div id="root"></div></body>
</html>
`
const PRO_SHELL = '<!doctype html><html lang="el"><head><title>Anaklo Pro</title></head></html>'

const PROFILE = {
  slug: 'demo-barber',
  name: 'Demo <Barber>',
  vertical: 'barber',
  timezone: 'Europe/Athens',
  locale: 'el',
  theme: { primary: '#1F3A5F' },
}

function assetsFetch() {
  return vi.fn<AssetsBinding['fetch']>((input) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname
    if (path === '/index.html') return Promise.resolve(new Response(BOOKING_SHELL))
    if (path === '/app/index.html') return Promise.resolve(new Response(PRO_SHELL))
    return Promise.resolve(new Response('asset', { status: path === '/missing.js' ? 404 : 200 }))
  })
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: assetsFetch() },
    SUPABASE_URL: 'https://ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_server',
    PROXY_SECRET: 'proxy-secret',
    APP_ENV: 'dev',
    SUPABASE_REGION: 'eu-west-1',
    ...overrides,
  }
}

function supabase(rows: unknown[] | 'down' | 'error' = [PROFILE]) {
  return vi.fn<FetchLike>(() => {
    if (rows === 'down') return Promise.reject(new TypeError('fetch failed'))
    if (rows === 'error') return Promise.resolve(new Response('oops', { status: 500 }))
    return Promise.resolve(Response.json(rows))
  })
}

function get(path: string, init?: RequestInit) {
  return new Request(`https://dev.anaklo.gr${path}`, init)
}

describe('resolveWorkerRoute', () => {
  it.each([
    ['/api/rest/v1/rpc/public_business_profile', 'api'],
    ['/assets/booking-abc.js', 'asset'],
    ['/app/sw.js', 'asset'],
    ['/favicon.svg', 'asset'],
    ['/app', 'pro-app'],
    ['/app/', 'pro-app'],
    ['/app/login', 'pro-app'],
    ['/m/abcdefghijklmnopqrstuv', 'token-page'],
    ['/', 'landing'],
    ['/demo-barber', 'business'],
    ['/api-barber', 'business'],
    ['/demo-barber/extra', 'not-found'],
    ['/a', 'not-found'],
  ])('%s → %s', (path, kind) => {
    expect(resolveWorkerRoute(path).kind).toBe(kind)
  })
})

describe('handleRequest', () => {
  it('serves /<slug> with the business injected, from the booking shell', async () => {
    const e = env()
    const fetch = supabase()
    const response = await handleRequest(get('/demo-barber'), e, fetch)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    const html = await response.text()
    expect(html).toContain('<title>Demo &lt;Barber&gt;</title>')
    expect(html).toContain('<meta property="og:url" content="https://dev.anaklo.gr/demo-barber" />')
    expect(html).toContain('<meta name="theme-color" content="#1F3A5F" />')
    expect(html).toContain('id="anaklo-initial"')

    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://ref.supabase.co/rest/v1/rpc/public_business_profile')
    expect(new Headers(init?.headers).get('apikey')).toBe('sb_publishable_server')
    expect(init?.body).toBe('{"p_slug":"demo-barber"}')
  })

  it('serves the shell with 404 for an unknown or hidden business', async () => {
    const response = await handleRequest(get('/no-such-shop'), env(), supabase([]))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe(BOOKING_SHELL)
  })

  it.each(['down', 'error'] as const)(
    'serves the plain shell with 200 when Supabase is %s',
    async (state) => {
      const response = await handleRequest(get('/demo-barber'), env(), supabase(state))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(BOOKING_SHELL)
    },
  )

  it('serves the pro app shell for /app routes, fetched without html handling', async () => {
    const assets = assetsFetch()
    const response = await handleRequest(
      get('/app/login'),
      env({ ASSETS: { fetch: assets } }),
      supabase(),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(PRO_SHELL)
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(assets).toHaveBeenCalledWith('https://dev.anaklo.gr/app/index.html')
  })

  it('serves token pages with no-referrer and no-store', async () => {
    const response = await handleRequest(get('/m/abcdefghijklmnopqrstuv'), env(), supabase())
    expect(response.status).toBe(200)
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves the landing page at / and 404 for other paths, without calling Supabase', async () => {
    const fetch = supabase()
    expect((await handleRequest(get('/'), env(), fetch)).status).toBe(200)
    expect((await handleRequest(get('/demo-barber/extra'), env(), fetch)).status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes paths with a file extension to the assets', async () => {
    const assets = assetsFetch()
    const request = get('/missing.js')
    const response = await handleRequest(request, env({ ASSETS: { fetch: assets } }), supabase())
    expect(response.status).toBe(404)
    expect(assets).toHaveBeenCalledWith(request)
  })

  it('proxies /api with the client IP from CF-Connecting-IP', async () => {
    const fetch = supabase()
    const request = get('/api/functions/v1/health', {
      headers: { 'CF-Connecting-IP': '198.51.100.4', 'X-Forwarded-For': '6.6.6.6' },
    })
    const response = await handleRequest(request, env(), fetch)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const headers = new Headers(fetch.mock.calls[0]?.[1].headers)
    expect(headers.get('x-anaklo-client-ip')).toBe('198.51.100.4')
    expect(headers.get('x-anaklo-proxy-secret')).toBe('proxy-secret')
  })

  it('answers HEAD without a body and refuses other methods on pages', async () => {
    const head = await handleRequest(get('/', { method: 'HEAD' }), env(), supabase())
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await handleRequest(get('/demo-barber', { method: 'POST' }), env(), supabase())
    expect(post.status).toBe(405)
  })
})
