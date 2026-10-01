// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { OneSignalPushPayload } from './onesignal.ts'
import {
  createFakePushProvider,
  createOneSignalPushProvider,
  createPushProvider,
  FAKE_PUSH_APP_ID,
  type PushSendRequest,
} from './push-provider.ts'
import { renderPushAllLocales } from './push-templates.ts'

const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'
const OTHER_DEVICE = '0c7e1d2a-9b4f-4e3a-8d6c-5a1b2c3d4e5f'
const APP_ID = '5f0e0d0c-0000-4000-8000-0000000000aa'
const REST_KEY = 'os_v2_app_testkeynotreal000000000000'

const REQUEST: PushSendRequest = {
  subscriptionIds: [DEVICE, OTHER_DEVICE],
  texts: renderPushAllLocales('push_test'),
  url: 'http://localhost:5173/app/',
}

const FORBIDDEN_KEYS = [
  'external_id',
  'include_aliases',
  'include_external_user_ids',
  'include_player_ids',
  'included_segments',
  'filters',
]

describe('fake push sender', () => {
  it('builds the exact OneSignal payload, records it and sends nothing', async () => {
    const recorded: OneSignalPushPayload[] = []
    const provider = createFakePushProvider({
      env: 'dev',
      record: (payload) => recorded.push(payload),
      log: () => {
        throw new Error('the fake sender must not log outside local')
      },
      randomId: () => '00000000-0000-4000-8000-000000000abc',
    })
    expect(provider.name).toBe('fake')
    await expect(provider.send(REQUEST)).resolves.toEqual({
      ok: true,
      providerMessageId: 'fake-push-00000000-0000-4000-8000-000000000abc',
    })
    expect(recorded).toEqual([
      {
        app_id: FAKE_PUSH_APP_ID,
        target_channel: 'push',
        include_subscription_ids: [DEVICE, OTHER_DEVICE],
        headings: { en: REQUEST.texts.en.title, el: REQUEST.texts.el.title },
        contents: { en: REQUEST.texts.en.body, el: REQUEST.texts.el.body },
        url: 'http://localhost:5173/app/',
      },
    ])
  })

  it('addresses only include_subscription_ids + target_channel, never an identity', async () => {
    const recorded: OneSignalPushPayload[] = []
    const provider = createFakePushProvider({ env: 'local', record: (p) => recorded.push(p) })
    await provider.send(REQUEST)
    const payload = recorded[0]
    expect(payload?.target_channel).toBe('push')
    const serialised = JSON.stringify(payload)
    for (const forbidden of FORBIDDEN_KEYS) expect(serialised).not.toContain(forbidden)
  })

  it('refuses an id that is not a subscription id, without recording anything', async () => {
    const recorded: OneSignalPushPayload[] = []
    const provider = createFakePushProvider({ env: 'local', record: (p) => recorded.push(p) })
    for (const subscriptionIds of [['owner@demo-barber.test'], []]) {
      await expect(provider.send({ ...REQUEST, subscriptionIds })).resolves.toEqual({
        ok: false,
        outcome: 'failed',
        error: 'invalid_payload',
      })
    }
    expect(recorded).toEqual([])
  })

  it('logs one line with ANAKLO_ENV=local: the count and the Greek title, no id', async () => {
    const lines: string[] = []
    const provider = createFakePushProvider({ env: 'local', log: (line) => lines.push(line) })
    const result = await provider.send(REQUEST)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.providerMessageId).toMatch(/^fake-push-[0-9a-f-]{36}$/)
    expect(lines).toEqual([`fake-push subscriptions=2 title=${REQUEST.texts.el.title}`])
    expect(lines.join('')).not.toContain(DEVICE)
  })

  it('is refused in prod', () => {
    expect(() => createFakePushProvider({ env: 'prod' })).toThrow(/refused in prod/)
    expect(() =>
      createPushProvider({ env: 'prod', provider: 'fake', oneSignal: null, fetch }),
    ).toThrow(/refused in prod/)
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

describe('OneSignal push sender (used from 1.10)', () => {
  const sender = (fetchImpl: typeof fetch) =>
    createOneSignalPushProvider({ appId: APP_ID, restApiKey: REST_KEY, fetch: fetchImpl })

  it('posts the payload to the notifications endpoint with the Key header', async () => {
    const http = fakeFetch(jsonResponse({ id: 'b98881cc-1e94-4366-bbd9-db8f3429292b' }))
    const result = await sender(http.fetch).send(REQUEST)
    expect(result).toEqual({ ok: true, providerMessageId: 'b98881cc-1e94-4366-bbd9-db8f3429292b' })
    expect(http.calls).toHaveLength(1)
    const call = http.calls[0]
    expect(call?.url).toBe('https://api.onesignal.com/notifications?c=push')
    expect(call?.init?.method).toBe('POST')
    const headers = new Headers(call?.init?.headers)
    expect(headers.get('Authorization')).toBe(`Key ${REST_KEY}`)
    expect(headers.get('Content-Type')).toBe('application/json')
    const sentBody = call?.init?.body
    expect(typeof sentBody).toBe('string')
    const body = JSON.parse(typeof sentBody === 'string' ? sentBody : 'null') as Record<
      string,
      unknown
    >
    expect(body).toMatchObject({
      app_id: APP_ID,
      target_channel: 'push',
      include_subscription_ids: [DEVICE, OTHER_DEVICE],
    })
    for (const forbidden of FORBIDDEN_KEYS) expect(Object.keys(body)).not.toContain(forbidden)
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('maps 2xx without id to rejected not_subscribed', async () => {
    for (const body of [
      { id: '' },
      {},
      { id: null, errors: ['All included players are not subscribed'] },
    ]) {
      const result = await sender(fakeFetch(jsonResponse(body)).fetch).send(REQUEST)
      expect(result).toEqual({ ok: false, outcome: 'rejected', error: 'not_subscribed' })
    }
  })

  it('maps 4xx and 5xx to failed http_<status> (certainly not delivered)', async () => {
    for (const status of [400, 403, 429, 500, 503]) {
      const result = await sender(fakeFetch(jsonResponse({ errors: ['x'] }, status)).fetch).send(
        REQUEST,
      )
      expect(result).toEqual({ ok: false, outcome: 'failed', error: `http_${status}` })
    }
  })

  it('maps a timeout or a network error to unknown (never retried)', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    expect(await sender(fakeFetch(timeout).fetch).send(REQUEST)).toEqual({
      ok: false,
      outcome: 'unknown',
      error: 'timeout',
    })
    expect(await sender(fakeFetch(new TypeError('fetch failed')).fetch).send(REQUEST)).toEqual({
      ok: false,
      outcome: 'unknown',
      error: 'network',
    })
  })

  it('times out for real after timeoutMs', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason: unknown = init.signal?.reason
          reject(reason instanceof Error ? reason : new Error('aborted'))
        })
      })
    const provider = createOneSignalPushProvider({
      appId: APP_ID,
      restApiKey: REST_KEY,
      fetch: hanging,
      timeoutMs: 20,
    })
    expect(await provider.send(REQUEST)).toEqual({
      ok: false,
      outcome: 'unknown',
      error: 'timeout',
    })
  })

  it('never calls OneSignal for an invalid target', async () => {
    const http = fakeFetch(jsonResponse({ id: 'x' }))
    const result = await sender(http.fetch).send({ ...REQUEST, subscriptionIds: ['external'] })
    expect(result).toEqual({ ok: false, outcome: 'failed', error: 'invalid_payload' })
    expect(http.calls).toEqual([])
  })

  it('is chosen by createPushProvider only with its keys', () => {
    const http = fakeFetch(jsonResponse({ id: 'x' }))
    expect(
      createPushProvider({
        env: 'prod',
        provider: 'onesignal',
        oneSignal: { appId: APP_ID, restApiKey: REST_KEY },
        fetch: http.fetch,
      }).name,
    ).toBe('onesignal')
    expect(() =>
      createPushProvider({ env: 'dev', provider: 'onesignal', oneSignal: null, fetch: http.fetch }),
    ).toThrow(/keys/)
  })
})
