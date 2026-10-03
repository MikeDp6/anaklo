import { z } from 'zod/mini'
import type { Log, RpcResult } from './booking-rpc.ts'
import { HealthCheckName } from './domain.ts'
import { errorResponse, json, requireMethod, requireProxy } from './http.ts'

/**
 * `GET /functions/v1/health` (ADR-0008 §3, contract 1.9 §3.1): proves that the functions are
 * deployed, that the proxy secret matches, where they run, and since 1.9 that the background jobs
 * are alive: `public.health()` (service_role only) reports, per job of `private.health_jobs`, the
 * age of its latest successful run, and the oldest unfinished security event. Any stale check →
 * 503, which the uptime monitor of 1.10 pages on.
 *
 * Public through the Worker on purpose (`/api/functions/v1/health`: the monitor has no
 * credential); a direct call is refused by the proxy secret. The body carries check names, ages,
 * thresholds and stale flags only (and the region): never counts, ids, users or businesses.
 * Pure (ADR-0002 §3): `health/index.ts` reads the environment and passes the RPC in.
 */

/** The database answers in milliseconds; a hung one must not hang the monitor. */
export const HEALTH_RPC_TIMEOUT_MS = 5_000

const Check = z.strictObject({
  name: HealthCheckName,
  age_seconds: z.nullable(z.int().check(z.gte(0))),
  max_age_seconds: z.int(),
  stale: z.boolean(),
})

/** What `public.health()` returns (contract 1.9 §2.4): exactly these keys. */
export const HealthResult = z.strictObject({ ok: z.boolean(), checks: z.array(Check) })
export type HealthResult = z.infer<typeof HealthResult>
export type HealthCheck = HealthResult['checks'][number]

/** `rpc('health')` with an abort signal (supabase-js `.abortSignal()`). */
export type HealthRpc = (signal: AbortSignal) => Promise<RpcResult>

export type HealthRuntime = {
  readonly proxySecret: string | undefined
  /** null: `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing (500 not_configured). */
  readonly rpc: HealthRpc | null
  /** `SB_REGION`/`DENO_REGION` when it looks like a region, else null (not in the body). */
  readonly region: string | null
  readonly log: Log
}

export type HealthDeps = {
  /** Tests shorten it; default `HEALTH_RPC_TIMEOUT_MS`. */
  readonly timeoutMs?: number
}

const REGION = /^[a-z0-9-]{1,32}$/

/** The runtime's region when it looks like one (`eu-west-1`), else null. */
export function parseRegion(raw: string | null | undefined): string | null {
  const region = raw ?? ''
  return REGION.test(region) ? region : null
}

type Answer = { ok: true; result: HealthResult } | { ok: false; code: string }

/** The RPC within the timeout; any error, timeout, throw or body off the contract is a code. */
async function readHealth(rpc: HealthRpc, timeoutMs: number): Promise<Answer> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Answer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, code: 'timeout' })
    }, timeoutMs)
  })
  const answer = (async (): Promise<Answer> => {
    try {
      const { data, error } = await rpc(controller.signal)
      if (error !== null) return { ok: false, code: error.code ?? 'rpc_error' }
      const parsed = HealthResult.safeParse(data)
      return parsed.success
        ? { ok: true, result: parsed.data }
        : { ok: false, code: 'invalid_result' }
    } catch {
      return { ok: false, code: 'exception' }
    }
  })()
  try {
    return await Promise.race([answer, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function handleHealth(
  req: Request,
  runtime: HealthRuntime,
  deps: HealthDeps = {},
): Promise<Response> {
  const proxy = requireProxy(req, runtime.proxySecret)
  if (!proxy.ok) return proxy.response
  const method = requireMethod(req, 'GET')
  if (!method.ok) return method.response
  if (runtime.rpc === null) {
    return errorResponse('not_configured', 'The health function is not configured.', 500)
  }

  const answer = await readHealth(runtime.rpc, deps.timeoutMs ?? HEALTH_RPC_TIMEOUT_MS)
  if (!answer.ok) {
    runtime.log('health_unavailable', { code: answer.code })
    return errorResponse('database_unavailable', 'The database did not answer.', 503)
  }

  const { checks } = answer.result
  const stale = checks.filter((check) => check.stale).map((check) => check.name)
  // A body that says ok while a check is stale (or the reverse) is not trusted: 503.
  const ok = answer.result.ok && stale.length === 0
  if (!ok) runtime.log('health_stale', { stale })
  const region = runtime.region === null ? {} : { region: runtime.region }
  return json({ ok, ...region, checks }, { status: ok ? 200 : 503 })
}
