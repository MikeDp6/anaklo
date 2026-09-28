// @vitest-environment node
// Request/Response/Headers from Node (undici), the same Fetch API the Deno runtime provides.
import { describe, expect, it } from 'vitest'
import { z } from 'zod/mini'
import {
  constantTimeEqual,
  errorResponse,
  json,
  MAX_JSON_BODY_BYTES,
  parseJsonBody,
  requireMethod,
  requireProxy,
  type ErrorBody,
} from './http.ts'
import { PROXY_HEADERS } from './proxy-contract.ts'

const SECRET = 'local-dev-proxy-secret-change-me'
const ENDPOINT = 'http://localhost/functions/v1/health'

function request(headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(ENDPOINT, { ...init, headers })
}

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  const body = (await response.json()) as ErrorBody
  return body.error
}

describe('requireProxy', () => {
  it('accepts the right secret', () => {
    const check = requireProxy(request({ [PROXY_HEADERS.secret]: SECRET }), SECRET)
    expect(check.ok).toBe(true)
  })

  it('refuses a request without the secret header with 403', async () => {
    const check = requireProxy(request(), SECRET)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.response.status).toBe(403)
    expect((await errorOf(check.response)).code).toBe('forbidden')
  })

  it('refuses a wrong, empty, longer or shorter secret with 403', () => {
    for (const provided of ['', 'wrong', `${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase()]) {
      const check = requireProxy(request({ [PROXY_HEADERS.secret]: provided }), SECRET)
      expect(check.ok ? 200 : check.response.status).toBe(403)
    }
  })

  it('answers 500 and never accepts when the configured secret is missing or empty', async () => {
    for (const configured of [undefined, null, '', '   ']) {
      // Even a request that sends the very same (empty) value is refused.
      const check = requireProxy(request({ [PROXY_HEADERS.secret]: configured ?? '' }), configured)
      expect(check.ok).toBe(false)
      if (check.ok) return
      expect(check.response.status).toBe(500)
      expect((await errorOf(check.response)).code).toBe('proxy_not_configured')
    }
  })

  it('treats an unresolved env() placeholder or a short secret as not configured', () => {
    for (const configured of ['env(PROXY_SECRET)', 'short-secret']) {
      const check = requireProxy(request({ [PROXY_HEADERS.secret]: configured }), configured)
      expect(check.ok ? 200 : check.response.status).toBe(500)
    }
  })

  it('reads the client IP only from the proxy header', () => {
    const check = requireProxy(
      request({
        [PROXY_HEADERS.secret]: SECRET,
        [PROXY_HEADERS.clientIp]: '203.0.113.7',
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
      }),
      SECRET,
    )
    expect(check).toEqual({ ok: true, clientIp: '203.0.113.7' })
  })

  it('never falls back to x-forwarded-for or x-real-ip', () => {
    const check = requireProxy(
      request({
        [PROXY_HEADERS.secret]: SECRET,
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
      }),
      SECRET,
    )
    expect(check).toEqual({ ok: true, clientIp: null })
  })

  it('accepts IPv6 and ignores a malformed client IP header', () => {
    const ipv6 = requireProxy(
      request({ [PROXY_HEADERS.secret]: SECRET, [PROXY_HEADERS.clientIp]: '2001:db8::1' }),
      SECRET,
    )
    expect(ipv6).toEqual({ ok: true, clientIp: '2001:db8::1' })
    const junk = requireProxy(
      request({ [PROXY_HEADERS.secret]: SECRET, [PROXY_HEADERS.clientIp]: '<script>' }),
      SECRET,
    )
    expect(junk).toEqual({ ok: true, clientIp: null })
  })
})

describe('constantTimeEqual', () => {
  it('is plain string equality', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abd', 'abc')).toBe(false)
    expect(constantTimeEqual('ab', 'abc')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('\u0000', '')).toBe(false)
  })
})

describe('responses', () => {
  it('json() is never cached', async () => {
    const response = json({ ok: true }, { status: 201 })
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('errorResponse() has the one error shape and is never cached', async () => {
    const response = errorResponse('business_mismatch', 'Mismatch.', 400)
    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      error: { code: 'business_mismatch', message: 'Mismatch.' },
    })
  })

  it('requireMethod() answers 405 with Allow', () => {
    const check = requireMethod(request({}, { method: 'GET' }), 'POST')
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.response.status).toBe(405)
    expect(check.response.headers.get('Allow')).toBe('POST')
    expect(requireMethod(request({}, { method: 'GET' }), 'GET').ok).toBe(true)
  })
})

describe('parseJsonBody', () => {
  const Body = z.object({ business_id: z.string() })

  function post(body: string): Request {
    return new Request(ENDPOINT, { method: 'POST', body })
  }

  it('returns the parsed body', async () => {
    const result = await parseJsonBody(post('{"business_id":"b","extra":1}'), Body)
    expect(result).toEqual({ ok: true, data: { business_id: 'b' } })
  })

  it('answers 400 for invalid JSON and for a body that does not match', async () => {
    for (const body of ['{', '', '[]', '{"business_id":1}']) {
      const result = await parseJsonBody(post(body), Body)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.response.status).toBe(400)
      expect((await errorOf(result.response)).code).toBe('invalid_body')
    }
  })

  it('answers 413 for a body over the limit', async () => {
    const big = JSON.stringify({ business_id: 'x'.repeat(MAX_JSON_BODY_BYTES) })
    const result = await parseJsonBody(post(big), Body)
    expect(result.ok ? 200 : result.response.status).toBe(413)
  })

  it('answers 413 for a streamed body without Content-Length, without buffering it', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 4096
          controller.enqueue(new Uint8Array(4096).fill(0x20))
        },
      },
      { highWaterMark: 0 },
    )
    const req = new Request(ENDPOINT, {
      method: 'POST',
      body: endless,
      duplex: 'half',
    } as RequestInit)
    expect(req.headers.get('content-length')).toBeNull()
    const result = await parseJsonBody(req, Body)
    expect(result.ok ? 200 : result.response.status).toBe(413)
    expect(pulled).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + 4096)
  })

  it('answers 400 for a Content-Length that is not a number', async () => {
    const req = post('{"business_id":"b"}')
    req.headers.set('content-length', 'abc')
    const result = await parseJsonBody(req, Body)
    expect(result.ok ? 200 : result.response.status).toBe(400)
  })
})
