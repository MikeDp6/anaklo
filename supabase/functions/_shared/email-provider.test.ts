// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createEmailProvider,
  createFakeEmailProvider,
  createResendEmailProvider,
  maskEmail,
  RESEND_EMAILS_URL,
  type EmailSendRequest,
} from './email-provider.ts'

const REQUEST: EmailSendRequest = {
  to: 'nikos@demo-barber.test',
  subject: 'Anaklo: an authenticator device was removed without approval',
  text: 'On 03/10/2026 at 21:07 an authenticator device was removed from the account …',
  idempotencyKey: 'security:5b0e8f3c-1a2d-4e5f-8a9b-0c1d2e3f4a5b:0',
}

describe('maskEmail', () => {
  it('keeps the first character and the domain only', () => {
    expect(maskEmail('nikos@demo-barber.test')).toBe('n***@demo-barber.test')
    expect(maskEmail('Ν@demo.test')).toBe('Ν***@demo.test')
    for (const bad of ['', 'nikos', '@demo.test', 'nikos@']) expect(maskEmail(bad)).toBe('***')
  })
})

describe('fake email sender (contract 1.9 §3.3)', () => {
  it('records the exact request and sends nothing', async () => {
    const recorded: EmailSendRequest[] = []
    const provider = createFakeEmailProvider({
      env: 'dev',
      record: (request) => recorded.push(request),
      log: () => {
        throw new Error('the fake sender must not log outside local')
      },
      randomId: () => '00000000-0000-4000-8000-000000000abc',
    })
    expect(provider.name).toBe('fake')
    await expect(provider.send(REQUEST)).resolves.toEqual({
      ok: true,
      providerMessageId: 'fake-email-00000000-0000-4000-8000-000000000abc',
    })
    expect(recorded).toEqual([REQUEST])
  })

  it('logs one line in local: masked address, key and subject, never the body', async () => {
    const lines: string[] = []
    const provider = createFakeEmailProvider({ env: 'local', log: (line) => lines.push(line) })
    const result = await provider.send(REQUEST)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.providerMessageId).toMatch(/^fake-email-[0-9a-f-]{36}$/)
    expect(lines).toEqual([
      `fake-email to=n***@demo-barber.test key=${REQUEST.idempotencyKey} subject=${REQUEST.subject}`,
    ])
    expect(lines.join('')).not.toContain('nikos@')
    expect(lines.join('')).not.toContain(REQUEST.text)
  })

  it('answers failed invalid_recipient for a recipient that is not an email, recording nothing', async () => {
    const recorded: EmailSendRequest[] = []
    const lines: string[] = []
    const provider = createFakeEmailProvider({
      env: 'local',
      record: (request) => recorded.push(request),
      log: (line) => lines.push(line),
    })
    for (const to of ['', 'nikos', 'nikos@', 'a b@demo.test', '+306900000001']) {
      await expect(provider.send({ ...REQUEST, to })).resolves.toEqual({
        ok: false,
        outcome: 'failed',
        error: 'invalid_recipient',
      })
    }
    expect(recorded).toEqual([])
    expect(lines).toEqual([])
  })

  it('is refused in prod', () => {
    expect(() => createFakeEmailProvider({ env: 'prod' })).toThrow(/refused in prod/)
    expect(() => createEmailProvider({ env: 'prod', provider: 'fake' })).toThrow(/refused in prod/)
  })

  it('createEmailProvider builds the fake sender with its record and log', async () => {
    const recorded: EmailSendRequest[] = []
    const lines: string[] = []
    const provider = createEmailProvider({
      env: 'local',
      provider: 'fake',
      record: (request) => recorded.push(request),
      log: (line) => lines.push(line),
    })
    expect(provider.name).toBe('fake')
    await provider.send(REQUEST)
    expect(recorded).toEqual([REQUEST])
    expect(lines).toHaveLength(1)
  })
})

type Call = { url: string; init: RequestInit | undefined }

function fakeFetch(answer: Response | Error) {
  const calls: Call[] = []
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init })
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  const typed: typeof fetch = impl
  return { fetch: typed, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const API_KEY = 're_test_not_a_real_key_000000000000'
const FROM = 'Anaklo <security@mail.anaklo.gr>'

describe('Resend sender (1.10; tested with a fake fetch only)', () => {
  it('posts one plain-text email with the idempotency key and answers the id', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: 'b2f1c0de-0000-4000-8000-000000000001' }))
    const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, fetch })
    expect(provider.name).toBe('resend')
    await expect(provider.send(REQUEST)).resolves.toEqual({
      ok: true,
      providerMessageId: 'b2f1c0de-0000-4000-8000-000000000001',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(RESEND_EMAILS_URL)
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('Idempotency-Key')).toBe(REQUEST.idempotencyKey)
    expect(headers.get('Content-Type')).toBe('application/json')
    const sentBody = calls[0]?.init?.body
    expect(typeof sentBody).toBe('string')
    expect(JSON.parse(typeof sentBody === 'string' ? sentBody : 'null')).toEqual({
      from: FROM,
      to: [REQUEST.to],
      subject: REQUEST.subject,
      text: REQUEST.text,
    })
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps statuses: 429 and 5xx failed, other 4xx rejected', async () => {
    const cases: Array<[number, string]> = [
      [429, 'failed'],
      [500, 'failed'],
      [503, 'failed'],
      [400, 'rejected'],
      [401, 'rejected'],
      [403, 'rejected'],
      [422, 'rejected'],
    ]
    for (const [status, outcome] of cases) {
      const { fetch } = fakeFetch(jsonResponse({ message: 'nope' }, status))
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, fetch })
      await expect(provider.send(REQUEST)).resolves.toEqual({
        ok: false,
        outcome,
        error: `http_${status}`,
      })
    }
  })

  it('answers unknown when it cannot tell: network, timeout, unreadable or id-less 2xx', async () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    const cases: Array<[Response | Error, string]> = [
      [new TypeError('fetch failed'), 'network'],
      [timeout, 'timeout'],
      [new Response('not json', { status: 200 }), 'invalid_response'],
      [jsonResponse({}), 'invalid_response'],
      [jsonResponse({ id: '  ' }), 'invalid_response'],
    ]
    for (const [answer, error] of cases) {
      const { fetch } = fakeFetch(answer)
      const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, fetch })
      await expect(provider.send(REQUEST)).resolves.toEqual({
        ok: false,
        outcome: 'unknown',
        error,
      })
    }
  })

  it('never calls Resend for a recipient that is not an email', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse({ id: 'x' }))
    const provider = createResendEmailProvider({ apiKey: API_KEY, from: FROM, fetch })
    await expect(provider.send({ ...REQUEST, to: 'nikos' })).resolves.toEqual({
      ok: false,
      outcome: 'failed',
      error: 'invalid_recipient',
    })
    expect(calls).toEqual([])
  })
})
