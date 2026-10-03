// @vitest-environment node
// Request/Response/Headers from Node (undici), the same Fetch API the Deno runtime provides.
//
// `health` (contract 1.9 §3.1) against a stand-in of `public.health()`. The SQL (thresholds,
// watched_since, the security_events check) is pgTAP `16_health`; the local 503 drill is §5.5-B.
import { describe, expect, it } from 'vitest'
import type { LogValue, RpcResult } from './booking-rpc.ts'
import { HEALTH_CHECK_NAMES } from './domain.ts'
import {
  handleHealth,
  HEALTH_RPC_TIMEOUT_MS,
  parseRegion,
  type HealthCheck,
  type HealthRpc,
  type HealthRuntime,
} from './health-handler.ts'
import { PROXY_HEADERS } from './proxy-contract.ts'

const SECRET = 'local-dev-proxy-secret-change-me'
const ENDPOINT = 'http://localhost/functions/v1/health'

const MAX_AGE: Record<string, number> = {
  auto_complete: 1800,
  detect_factor_changes: 900,
  dispatch: 900,
  dispatch_sweep: 900,
  purge: 93600,
  security_events: 900,
}

function checks(stale: readonly string[] = []): HealthCheck[] {
  return [...HEALTH_CHECK_NAMES].sort().map((name) => ({
    name,
    age_seconds: name === 'security_events' ? null : stale.includes(name) ? 1000 : 42,
    max_age_seconds: MAX_AGE[name] ?? 900,
    stale: stale.includes(name),
  }))
}

function healthy(): RpcResult {
  return { data: { ok: true, checks: checks() }, error: null }
}

type Harness = {
  runtime: HealthRuntime
  calls: number
  signals: AbortSignal[]
  logs: Array<{ event: string; fields: Readonly<Record<string, LogValue>> }>
}

function harness(
  answer: (signal: AbortSignal) => Promise<RpcResult> = () => Promise.resolve(healthy()),
  overrides: Partial<HealthRuntime> = {},
): Harness {
  const h: Harness = {
    calls: 0,
    signals: [],
    logs: [],
    runtime: {
      proxySecret: SECRET,
      rpc: null,
      region: null,
      log: (event, fields) => h.logs.push({ event, fields }),
    },
  }
  const rpc: HealthRpc = (signal) => {
    h.calls += 1
    h.signals.push(signal)
    return answer(signal)
  }
  h.runtime = { ...h.runtime, rpc, ...overrides }
  return h
}

function request(
  headers: Record<string, string> = { [PROXY_HEADERS.secret]: SECRET },
  method = 'GET',
) {
  return new Request(ENDPOINT, { method, headers })
}

async function call(h: Harness, req: Request = request(), timeoutMs?: number) {
  const response = await handleHealth(req, h.runtime, timeoutMs === undefined ? {} : { timeoutMs })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

describe('health: before the database (contract 1.9 §3.1)', () => {
  it('answers 403 without the proxy secret or with a wrong one, before anything else', async () => {
    const h = harness()
    const attempts: Array<Record<string, string>> = [
      {},
      { [PROXY_HEADERS.secret]: 'wrong' },
      { Authorization: `Bearer ${SECRET}` },
    ]
    for (const headers of attempts) {
      const { response, body } = await call(h, request(headers))
      expect(response.status).toBe(403)
      expect(body).toEqual({ error: { code: 'forbidden', message: 'Forbidden.' } })
    }
    // Even a POST without the secret is a 403, not a 405.
    expect((await call(h, request({}, 'POST'))).response.status).toBe(403)
    expect(h.calls).toBe(0)
  })

  it('answers 500 proxy_not_configured when PROXY_SECRET is missing or empty', async () => {
    for (const proxySecret of [undefined, '', 'env(PROXY_SECRET)']) {
      const h = harness(undefined, { proxySecret })
      const { response, body } = await call(
        h,
        request({ [PROXY_HEADERS.secret]: proxySecret ?? '' }),
      )
      expect(response.status).toBe(500)
      expect(body).toMatchObject({ error: { code: 'proxy_not_configured' } })
      expect(h.calls).toBe(0)
    }
  })

  it('answers 405 to anything but GET', async () => {
    const h = harness()
    const { response } = await call(h, request(undefined, 'POST'))
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(h.calls).toBe(0)
  })

  it('answers 500 not_configured without the service-role configuration', async () => {
    const h = harness(undefined, { rpc: null })
    const { response, body } = await call(h)
    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: { code: 'not_configured', message: 'The health function is not configured.' },
    })
  })
})

describe('health: the checks', () => {
  it('answers 200 { ok, checks } with no-store when no check is stale', async () => {
    const h = harness()
    const { response, body } = await call(h)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body).toEqual({ ok: true, checks: checks() })
    expect(h.calls).toBe(1)
    expect(h.logs).toEqual([])
  })

  it('adds the region when the runtime has one', async () => {
    const h = harness(undefined, { region: 'eu-west-1' })
    const { body } = await call(h)
    expect(body).toEqual({ ok: true, region: 'eu-west-1', checks: checks() })
    expect(parseRegion('eu-west-1')).toBe('eu-west-1')
    for (const bad of [undefined, null, '', 'EU West', 'x'.repeat(33)])
      expect(parseRegion(bad)).toBeNull()
  })

  it('answers 503 with the same body shape and nothing else when a check is stale', async () => {
    for (const stale of [
      ['dispatch'],
      ['dispatch', 'dispatch_sweep'],
      ['security_events'],
      ['purge'],
    ]) {
      const h = harness(() =>
        Promise.resolve({ data: { ok: false, checks: checks(stale) }, error: null }),
      )
      const { response, body } = await call(h)
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(body).toEqual({ ok: false, checks: checks(stale) })
      expect(Object.keys(body).sort()).toEqual(['checks', 'ok'])
      expect(h.logs).toEqual([{ event: 'health_stale', fields: { stale } }])
    }
  })

  it('does not trust a body whose ok disagrees with its checks: 503', async () => {
    for (const data of [
      { ok: true, checks: checks(['dispatch']) },
      { ok: false, checks: checks() },
    ]) {
      const h = harness(() => Promise.resolve({ data, error: null }))
      const { response, body } = await call(h)
      expect(response.status).toBe(503)
      expect(body).toMatchObject({ ok: false })
    }
  })

  it('answers 503 database_unavailable on an RPC error, a throw or a body off the contract', async () => {
    const extraKey = { ok: true, checks: checks(), jobs: 5 }
    const extraCheckKey = {
      ok: true,
      checks: checks().map((check) => ({ ...check, last_run_id: 'x' })),
    }
    const unknownName = { ok: true, checks: [{ ...checks()[0], name: 'cron' }] }
    const negativeAge = { ok: true, checks: [{ ...checks()[0], age_seconds: -1 }] }
    const cases: Array<[() => Promise<RpcResult>, string]> = [
      [() => Promise.resolve({ data: null, error: { code: '42501', message: 'denied' } }), '42501'],
      // functions deployed before the migration: PostgREST has no such function (runbook
      // booking-page-down.md §2.2 reads this code in the log)
      [
        () =>
          Promise.resolve({
            data: null,
            error: { code: 'PGRST202', message: 'Could not find the function public.health' },
          }),
        'PGRST202',
      ],
      [() => Promise.resolve({ data: null, error: { message: 'fetch failed' } }), 'rpc_error'],
      [() => Promise.reject(new Error('network')), 'exception'],
      [() => Promise.resolve({ data: extraKey, error: null }), 'invalid_result'],
      [() => Promise.resolve({ data: extraCheckKey, error: null }), 'invalid_result'],
      [() => Promise.resolve({ data: unknownName, error: null }), 'invalid_result'],
      [() => Promise.resolve({ data: negativeAge, error: null }), 'invalid_result'],
      [() => Promise.resolve({ data: null, error: null }), 'invalid_result'],
    ]
    for (const [answer, code] of cases) {
      const h = harness(answer)
      const { response, body } = await call(h)
      expect(response.status, code).toBe(503)
      expect(body).toEqual({
        error: { code: 'database_unavailable', message: 'The database did not answer.' },
      })
      expect(h.logs).toEqual([{ event: 'health_unavailable', fields: { code } }])
    }
  })

  it('gives up after the timeout, aborting the RPC: 503', async () => {
    expect(HEALTH_RPC_TIMEOUT_MS).toBe(5_000)
    const h = harness(
      (signal) =>
        new Promise<RpcResult>((resolve) => {
          // A database that never answers, until the signal aborts the request.
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { message: 'aborted' } }),
          )
        }),
    )
    const { response, body } = await call(h, request(), 20)
    expect(response.status).toBe(503)
    expect(body).toMatchObject({ error: { code: 'database_unavailable' } })
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.logs).toEqual([{ event: 'health_unavailable', fields: { code: 'timeout' } }])
  })

  it('never puts ids, counts, users or businesses in the body', async () => {
    const h = harness()
    const { body } = await call(h)
    for (const check of body.checks as Array<Record<string, unknown>>) {
      expect(Object.keys(check).sort()).toEqual(['age_seconds', 'max_age_seconds', 'name', 'stale'])
    }
  })
})
