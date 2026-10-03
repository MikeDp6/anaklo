import { z } from 'zod/mini'
import type { LogValue } from './booking-rpc.ts'
import type { DispatchRuntime, DispatchServices } from './dispatch-runtime.ts'
import { constantTimeEqual, errorResponse, json, parseJsonBody, requireMethod } from './http.ts'
import { handleSecurityEvents, type SecuritySummary } from './security-handler.ts'
import { sendClaimed, type SentOutcome } from './send.ts'

/**
 * `POST /functions/v1/dispatch` (contract 1.5 §3.1): the dispatcher of `messages_log`. Called
 * only by the database through pg_net (the nudge after a staff action or a test push, the sweep
 * every 5′) and by tests; NOT on the `/api` proxy's allow-list (`verify_jwt = false`: the
 * shared secret header is checked here instead). Pure (ADR-0002 §3): `dispatch/index.ts` builds
 * the runtime from `Deno.env` and serves every request through `handleDispatch`.
 *
 * Each round leases up to 5 due rows (`claim_due_messages`: never OTP), sends them (`send.ts`)
 * and records each result. A dispatcher killed mid-batch leaves its rows `sending`: no claim
 * ever returns them again, the sweep closes them as `unknown` and a late result of the dead
 * lease is refused, so every message is sent at most once (contract 1.5 D23).
 *
 * The answer and the logs carry counts, ids, templates and codes only: never phones, tokens,
 * subscription ids or names.
 *
 * 1.9 (contract 1.9 §3.2): every run starts with the SECURITY PHASE (`security-handler.ts`): the
 * authenticator-device changes the detector found without a grant are contained (an added factor
 * deleted, every session revoked) and notified (emails, and the owners' push queued in
 * `messages_log`, which the message rounds of the same run then send). The detector nudges with
 * `{ source: 'security' }`; the sweep's nudge every 5′ is the fallback.
 */

/** The header pg_net sends with Vault `dispatch_secret`. */
export const DISPATCH_SECRET_HEADER = 'x-anaklo-dispatch-secret'

/** `{ source }` is all the body carries. */
export const DISPATCH_MAX_BODY_BYTES = 1024

export const DISPATCH_SOURCES = ['nudge', 'sweep', 'test', 'security'] as const
export const DispatchRequest = z.strictObject({ source: z.enum(DISPATCH_SOURCES) })
export type DispatchRequest = z.infer<typeof DispatchRequest>

/** Rows per claim: with the 8 s provider timeout a batch ends well inside its 60 s lease. */
export const DISPATCH_BATCH_SIZE = 5
export const DISPATCH_MAX_ROUNDS = 5
/** No new round starts after this long (the edge runtime's wall clock is limited). */
export const DISPATCH_TIME_BUDGET_MS = 25_000

const ClaimDueResult = z.object({ items: z.array(z.unknown()), more: z.boolean() })

export type DispatchSummary = {
  rounds: number
  claimed: number
  sent: number
  failed: number
  rejected: number
  unknown: number
  /** 1.9: the security phase, counts only. */
  security: SecuritySummary
}

export type DispatchDeps = {
  /** Milliseconds since the epoch (tests pass a fake clock). */
  readonly now?: () => number
}

function tally(summary: DispatchSummary, outcomes: Record<string, SentOutcome>): void {
  for (const outcome of Object.values(outcomes)) summary[outcome] += 1
}

async function run(
  services: DispatchServices,
  log: DispatchRuntime['log'],
  now: () => number,
): Promise<{ summary: DispatchSummary; ok: boolean; error: string | null }> {
  const { rpc } = services
  const started = now()

  // 1.9: the security phase first (≤ 15 s), so the owners' push it queues goes out in the
  // message rounds below.
  const security = await handleSecurityEvents(services, log, now)

  const summary: DispatchSummary = {
    rounds: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    rejected: 0,
    unknown: 0,
    security: security.summary,
  }
  let ok = security.ok
  let error: string | null = security.error

  while (summary.rounds < DISPATCH_MAX_ROUNDS && now() - started < DISPATCH_TIME_BUDGET_MS) {
    let claimed: z.infer<typeof ClaimDueResult>
    try {
      const result = await rpc('claim_due_messages', { p_limit: DISPATCH_BATCH_SIZE })
      if (result.error !== null) {
        ok = false
        error ??= result.error.code ?? 'claim_failed'
        log('dispatch_claim_failed', { sqlstate: result.error.code ?? null })
        break
      }
      const parsed = ClaimDueResult.safeParse(result.data)
      if (!parsed.success) {
        ok = false
        error ??= 'invalid_claim'
        log('dispatch_claim_failed', { sqlstate: null, reason: 'invalid_result' })
        break
      }
      claimed = parsed.data
    } catch {
      ok = false
      error ??= 'claim_exception'
      log('dispatch_claim_failed', { sqlstate: null, reason: 'exception' })
      break
    }

    summary.rounds += 1
    summary.claimed += claimed.items.length
    tally(summary, await sendClaimed({ ...services, log }, claimed.items))
    if (!claimed.more) break
  }

  // The heartbeat of 1.9's health check: one row per run, even when nothing was due. ok only
  // when both phases were; rows = messages sent + security events notified.
  try {
    const recorded = await rpc('record_dispatch_run', {
      p_started_at: new Date(started).toISOString(),
      p_ok: ok,
      p_rows: summary.sent + summary.security.notified,
      p_error: error,
    })
    if (recorded.error !== null) {
      log('dispatch_run_not_recorded', { sqlstate: recorded.error.code ?? null })
    }
  } catch {
    log('dispatch_run_not_recorded', { sqlstate: null })
  }
  return { summary, ok, error }
}

export async function handleDispatch(
  req: Request,
  runtime: DispatchRuntime,
  deps: DispatchDeps = {},
): Promise<Response> {
  const method = requireMethod(req, 'POST')
  if (!method.ok) return method.response
  if (runtime.services === null || runtime.secret === null) {
    return errorResponse('not_configured', 'The dispatch function is not configured.', 500)
  }
  const provided = req.headers.get(DISPATCH_SECRET_HEADER)
  if (provided === null || !constantTimeEqual(provided, runtime.secret)) {
    return errorResponse('forbidden', 'Forbidden.', 403)
  }
  const body = await parseJsonBody(req, DispatchRequest, DISPATCH_MAX_BODY_BYTES)
  if (!body.ok) return body.response

  const now = deps.now ?? (() => Date.now())
  let result: Awaited<ReturnType<typeof run>>
  try {
    result = await run(runtime.services, runtime.log, now)
  } catch {
    runtime.log('unhandled_error', { source: body.data.source })
    return errorResponse('internal', 'Internal error.', 500)
  }
  const { security, ...messages } = result.summary
  const fields: Record<string, LogValue> = {
    source: body.data.source,
    ...messages,
    security_claimed: security.claimed,
    security_contained: security.contained,
    security_notified: security.notified,
    security_failed: security.failed,
    ok: result.ok,
    error: result.error,
  }
  runtime.log('dispatch_run', fields)
  return json(result.summary)
}
