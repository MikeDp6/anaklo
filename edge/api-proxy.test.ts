// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { handleApiRequest, type FetchLike, type ProxyEnv } from './api-proxy.ts'

const BUSINESS = '0f0e0d0c-0000-4000-8000-000000000001'
const OTHER_BUSINESS = '0f0e0d0c-0000-4000-8000-000000000002'
const PROFILE_PATH = '/rest/v1/rpc/public_business_profile'
const SPIKE_PATH = '/functions/v1/spike-td'

const ENV: ProxyEnv = {
  SUPABASE_URL: 'https://ref.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_server',
  PROXY_SECRET: 'proxy-secret',
  APP_ENV: 'dev',
  SUPABASE_REGION: 'eu-west-1',
}

function upstream(response: () => Response = () => Response.json([])) {
  return vi.fn<FetchLike>(() => Promise.resolve(response()))
}

function call(
  path: string,
  init: RequestInit = {},
  options: { env?: ProxyEnv; fetch?: FetchLike; clientIp?: string | null } = {},
) {
  const fetch = options.fetch ?? upstream()
  const request = new Request(`https://dev.anaklo.gr${path}`, init)
  const clientIp = options.clientIp === undefined ? '203.0.113.7' : options.clientIp
  return handleApiRequest(request, options.env ?? ENV, { fetch, clientIp })
}

function sentHeaders(fetch: ReturnType<typeof upstream>, index = 0): Headers {
  const init = fetch.mock.calls[index]?.[1]
  return new Headers(init?.headers)
}

function spikeRequest(headers: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }
}

describe('handleApiRequest: forwarding', () => {
  it('forwards an allowed RPC with only safe client headers plus the proxy headers', async () => {
    const fetch = upstream()
    const response = await call(
      `/api${PROFILE_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Language': 'el-GR',
          apikey: 'sb_publishable_from_client',
          Authorization: 'Bearer client-jwt',
          Cookie: `__Host-td_${BUSINESS}=secret-token; other=1`,
          'X-Forwarded-For': '6.6.6.6',
          'X-Forwarded-Host': 'evil.test',
          'X-Real-IP': '6.6.6.6',
          Forwarded: 'for=6.6.6.6',
          'CF-Connecting-IP': '6.6.6.6',
          'x-anaklo-client-ip': '6.6.6.6',
          'x-anaklo-proxy-secret': 'guessed',
          'x-anaklo-td': 'forged-token',
          'x-anaklo-set-td': 'forged',
          'x-anaklo-anything': 'x',
        },
        body: JSON.stringify({ p_slug: 'demo-barber' }),
      },
      { fetch },
    )

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(`https://ref.supabase.co${PROFILE_PATH}`)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"p_slug":"demo-barber"}')

    const headers = sentHeaders(fetch)
    expect(Object.fromEntries(headers)).toEqual({
      accept: 'application/json',
      'accept-language': 'el-GR',
      apikey: 'sb_publishable_server',
      'content-type': 'application/json',
      'x-anaklo-client-ip': '203.0.113.7',
      'x-anaklo-proxy-secret': 'proxy-secret',
      'x-region': 'eu-west-1',
    })
  })

  it('never lets the Cookie header or its values reach Supabase', async () => {
    const fetch = upstream()
    await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ Cookie: `__Host-td_${OTHER_BUSINESS}=other-token; session=abc` }),
      { fetch },
    )
    const values = [...sentHeaders(fetch).values()].join('\n')
    expect(sentHeaders(fetch).has('cookie')).toBe(false)
    expect(values).not.toContain('other-token')
    expect(values).not.toContain('session')
  })

  it('keeps the query string and the PostgREST profile headers', async () => {
    const fetch = upstream()
    await call(
      '/api/functions/v1/health?probe=1',
      { headers: { Prefer: 'return=minimal', 'Accept-Profile': 'public' } },
      { fetch },
    )
    expect(fetch.mock.calls[0]?.[0]).toBe('https://ref.supabase.co/functions/v1/health?probe=1')
    expect(fetch.mock.calls[0]?.[1].body).toBeNull()
    expect(sentHeaders(fetch).get('prefer')).toBe('return=minimal')
    expect(sentHeaders(fetch).get('accept-profile')).toBe('public')
  })

  it('omits optional proxy headers it does not have', async () => {
    const fetch = upstream()
    const env = { ...ENV, SUPABASE_REGION: undefined, PROXY_SECRET: '' }
    await call('/api/functions/v1/health', {}, { env, fetch, clientIp: 'not an ip' })
    const headers = sentHeaders(fetch)
    expect(headers.has('x-region')).toBe(false)
    expect(headers.has('x-anaklo-proxy-secret')).toBe(false)
    expect(headers.has('x-anaklo-client-ip')).toBe(false)
    expect(headers.get('apikey')).toBe('sb_publishable_server')
  })
})

describe('handleApiRequest: business header and trusted-device cookie', () => {
  const cookies = `__Host-td_${OTHER_BUSINESS}=token-b; __Host-td_${BUSINESS}=token-a; td_${BUSINESS}=local-a`

  it('forwards only the cookie of the declared business, and the business again', async () => {
    const fetch = upstream()
    await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS.toUpperCase(), Cookie: cookies }),
      { fetch },
    )
    const headers = sentHeaders(fetch)
    expect(headers.get('x-anaklo-business')).toBe(BUSINESS)
    expect(headers.get('x-anaklo-td')).toBe('token-a')
  })

  it('re-adds the business without a td header when there is no cookie', async () => {
    const fetch = upstream()
    await call(`/api${SPIKE_PATH}`, spikeRequest({ 'x-anaklo-business': BUSINESS }), { fetch })
    expect(sentHeaders(fetch).get('x-anaklo-business')).toBe(BUSINESS)
    expect(sentHeaders(fetch).has('x-anaklo-td')).toBe(false)
  })

  it.each(['not-a-uuid', `${BUSINESS}, ${OTHER_BUSINESS}`, `${BUSINESS}x`, ''])(
    'forwards nothing for a business header %j that is not a UUID',
    async (business) => {
      const fetch = upstream(
        () => new Response('{}', { headers: { 'x-anaklo-set-td': 'new-token' } }),
      )
      const response = await call(
        `/api${SPIKE_PATH}`,
        spikeRequest({ 'x-anaklo-business': business, Cookie: cookies }),
        { fetch },
      )
      const headers = sentHeaders(fetch)
      expect(headers.has('x-anaklo-business')).toBe(false)
      expect(headers.has('x-anaklo-td')).toBe(false)
      expect(response.headers.getSetCookie()).toEqual([])
      expect(response.headers.has('x-anaklo-set-td')).toBe(false)
    },
  )

  it('round-trips header → cookie → header with the exact attributes', async () => {
    const issuing = upstream(
      () =>
        new Response('{"issued":true}', {
          headers: {
            'Content-Type': 'application/json',
            'x-anaklo-set-td': 'tok_123-abc',
            'Set-Cookie': 'sb-upstream=1; Path=/',
          },
        }),
    )
    const first = await call(`/api${SPIKE_PATH}`, spikeRequest({ 'x-anaklo-business': BUSINESS }), {
      fetch: issuing,
    })
    expect(first.headers.has('x-anaklo-set-td')).toBe(false)
    const setCookies = first.headers.getSetCookie()
    expect(setCookies).toEqual([
      `__Host-td_${BUSINESS}=tok_123-abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000; Secure`,
    ])
    expect(await first.json()).toEqual({ issued: true })

    const cookiePair = setCookies[0]?.split(';')[0] ?? ''
    const reading = upstream()
    await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS, Cookie: cookiePair }),
      { fetch: reading },
    )
    expect(sentHeaders(reading).get('x-anaklo-td')).toBe('tok_123-abc')
  })

  it('turns an empty set-td into a deletion', async () => {
    const fetch = upstream(() => new Response('{}', { headers: { 'x-anaklo-set-td': '' } }))
    const response = await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS }),
      { fetch },
    )
    expect(response.headers.getSetCookie()).toEqual([
      `__Host-td_${BUSINESS}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`,
    ])
  })

  it.each([
    ['local', `td_${BUSINESS}`, false],
    ['dev', `__Host-td_${BUSINESS}`, true],
    ['prod', `__Host-td_${BUSINESS}`, true],
    ['LOCAL', `__Host-td_${BUSINESS}`, true],
    ['', `__Host-td_${BUSINESS}`, true],
    [undefined, `__Host-td_${BUSINESS}`, true],
  ])('APP_ENV=%j writes %s (Secure: %s) and reads it back', async (appEnv, name, secure) => {
    const env = { ...ENV, APP_ENV: appEnv }
    const fetch = upstream(() => new Response('{}', { headers: { 'x-anaklo-set-td': 'tok' } }))
    const response = await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS }),
      { env, fetch },
    )
    const expected = `${name}=tok; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000`
    expect(response.headers.getSetCookie()).toEqual([secure ? `${expected}; Secure` : expected])

    const reading = upstream()
    await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS, Cookie: `${name}=tok` }),
      { env, fetch: reading },
    )
    expect(sentHeaders(reading).get('x-anaklo-td')).toBe('tok')
  })

  it('does not write a malformed token as a cookie', async () => {
    const fetch = upstream(
      () => new Response('{}', { headers: { 'x-anaklo-set-td': 'a; Domain=evil.test' } }),
    )
    const response = await call(
      `/api${SPIKE_PATH}`,
      spikeRequest({ 'x-anaklo-business': BUSINESS }),
      { fetch },
    )
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe('handleApiRequest: refusals', () => {
  it.each([
    ['/api/rest/v1/clients', 'GET'],
    ['/api/rest/v1/rpc/erase_client', 'POST'],
    ['/api/auth/v1/otp', 'POST'],
    ['/api/storage/v1/object/list/x', 'POST'],
    [`/api${PROFILE_PATH}/`, 'POST'],
    [`/api${PROFILE_PATH}`, 'GET'],
    ['/api/functions/v1/health', 'POST'],
    ['/api/functions/v1/dispatch', 'POST'],
    ['/api//rest/v1/rpc/public_business_profile', 'POST'],
    ['/api/rest/v1/rpc/public%5Fbusiness_profile', 'POST'],
    ['/api-barber', 'GET'],
    ['/api-barber/rest/v1/rpc/public_business_profile', 'POST'],
    ['/api', 'GET'],
  ])('refuses %s (%s) with 404 and never calls Supabase', async (path, method) => {
    const fetch = upstream()
    const body = method === 'POST' ? '{}' : null
    const response = await call(path, { method, body }, { fetch })
    expect(response.status).toBe(404)
    // Same error shape as the Edge Functions (`_shared/http.ts`).
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s with 405', async (method) => {
    const fetch = upstream()
    const response = await call(`/api${PROFILE_PATH}`, { method }, { fetch })
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET, POST')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a body over the limit before calling Supabase', async () => {
    const fetch = upstream()
    const response = await call(
      `/api${PROFILE_PATH}`,
      { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) },
      { fetch },
    )
    expect(response.status).toBe(413)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cuts off a streamed body without Content-Length as soon as it passes the limit', async () => {
    // Chunked HTTP/1.1 or HTTP/2 without Content-Length: 1 GB would otherwise be buffered.
    const state = { pulled: 0, cancelled: false }
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulled += 16 * 1024
          controller.enqueue(new Uint8Array(16 * 1024))
        },
        cancel() {
          state.cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const fetch = upstream()
    const request = new Request(`https://dev.anaklo.gr/api${SPIKE_PATH}`, {
      method: 'POST',
      body: endless,
      duplex: 'half',
    } as RequestInit)
    expect(request.headers.get('content-length')).toBeNull()

    const response = await handleApiRequest(request, ENV, { fetch, clientIp: '203.0.113.7' })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: { code: 'payload_too_large', message: 'Request body too large.' },
    })
    expect(state.pulled).toBeLessThanOrEqual(64 * 1024 + 16 * 1024)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.cancelled).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a Content-Length that is not a number (400), never reads it as 0', async () => {
    const fetch = upstream()
    const request = new Request(`https://dev.anaklo.gr/api${PROFILE_PATH}`, {
      method: 'POST',
      body: '{}',
    })
    request.headers.set('content-length', 'abc')
    const response = await handleApiRequest(request, ENV, { fetch, clientIp: null })
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers 502 with no-store when Supabase is unreachable', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new TypeError('fetch failed')))
    const response = await call('/api/functions/v1/health', {}, { fetch })
    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('handleApiRequest: responses', () => {
  it('passes status and body through, always with no-store', async () => {
    const fetch = upstream(
      () =>
        new Response('{"error":"forbidden"}', {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
            'x-anaklo-internal': 'x',
          },
        }),
    )
    const response = await call('/api/functions/v1/health', {}, { fetch })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('{"error":"forbidden"}')
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false)
    expect(response.headers.has('x-anaklo-internal')).toBe(false)
  })

  it('never passes an upstream Set-Cookie to the browser', async () => {
    const fetch = upstream(
      () => new Response('[]', { headers: { 'Set-Cookie': 'sb-access-token=x; Path=/' } }),
    )
    const response = await call(`/api${PROFILE_PATH}`, { method: 'POST', body: '{}' }, { fetch })
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('keeps a 204 empty', async () => {
    const fetch = upstream(() => new Response(null, { status: 204 }))
    const response = await call('/api/functions/v1/health', {}, { fetch })
    expect(response.status).toBe(204)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
