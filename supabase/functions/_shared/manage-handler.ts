import { z, type ZodMiniType } from 'zod/mini'
import {
  Id,
  Instant,
  ManageRequest,
  ManageSlot,
  ManageViewResponse,
  type ManageCancelRequest,
  type ManageCancelResponse,
  type ManageRescheduleRequest,
  type ManageRescheduleResponse,
  type ManageSlotsRequest,
  type ManageSlotsResponse,
  type ManageViewRequest,
} from './booking-schemas.ts'
import { callRpc, internalErrorResponse, type Log, type RpcOutcome } from './booking-rpc.ts'
import {
  notConfiguredResponse,
  type BookingRuntime,
  type BookingServices,
} from './booking-runtime.ts'
import { json, parseJsonBody, requireMethod, requireProxy } from './http.ts'
import { sendMessages } from './send.ts'

/**
 * `POST /api/functions/v1/manage` (contract 1.3 §5): the manage link `/m/<token>`. `view` and
 * `slots` change nothing; `cancel` and `reschedule` act as the client and then send the SMS the
 * planner queued. Everything is POST: nothing changes on GET (link previews, prefetchers).
 * Pure (ADR-0002 §3): `manage/index.ts` builds the runtime and serves through `handleManage`.
 *
 * The token is the only credential; it is never logged.
 */

const ManageSlotsResult = z.array(ManageSlot)

const ManageCancelResult = z.object({
  appointment_id: Id,
  status: z.literal('cancelled'),
  message_ids: z.array(Id),
})

const ManageRescheduleResult = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  message_ids: z.array(Id),
})

type Context = BookingServices & { readonly log: Log }

function parseResult<T>(
  log: Log,
  fn: string,
  outcome: Extract<RpcOutcome, { ok: true }>,
  schema: ZodMiniType<T>,
): T | null {
  const parsed = schema.safeParse(outcome.data)
  if (!parsed.success) log('rpc_invalid_result', { fn })
  return parsed.success ? parsed.data : null
}

async function view(ctx: Context, req: ManageViewRequest): Promise<Response> {
  const viewed = await callRpc(ctx.rpc, ctx.log, 'manage_view', { p_token: req.token })
  if (!viewed.ok) return viewed.response
  // Parsed (and stripped of unknown keys) so that nothing beyond the contract leaves.
  const result = parseResult(ctx.log, 'manage_view', viewed, ManageViewResponse)
  return result === null ? internalErrorResponse() : json(result)
}

async function slots(ctx: Context, req: ManageSlotsRequest): Promise<Response> {
  const found = await callRpc(ctx.rpc, ctx.log, 'manage_slots', {
    p_token: req.token,
    p_from: req.from,
    p_to: req.to,
  })
  if (!found.ok) return found.response
  const rows = parseResult(ctx.log, 'manage_slots', found, ManageSlotsResult)
  return rows === null
    ? internalErrorResponse()
    : json({ slots: rows } satisfies ManageSlotsResponse)
}

async function send(ctx: Context, ids: readonly string[]): Promise<void> {
  // The change has committed: a failed send is recorded and logged, never an error here.
  await sendMessages({
    rpc: ctx.rpc,
    provider: ctx.provider,
    config: ctx.config,
    ids,
    log: ctx.log,
  })
}

async function cancel(ctx: Context, req: ManageCancelRequest): Promise<Response> {
  const cancelled = await callRpc(ctx.rpc, ctx.log, 'manage_cancel', { p_token: req.token })
  if (!cancelled.ok) return cancelled.response
  const result = parseResult(ctx.log, 'manage_cancel', cancelled, ManageCancelResult)
  if (result === null) return internalErrorResponse()
  await send(ctx, result.message_ids)
  return json({ status: 'cancelled' } satisfies ManageCancelResponse)
}

async function reschedule(ctx: Context, req: ManageRescheduleRequest): Promise<Response> {
  const moved = await callRpc(ctx.rpc, ctx.log, 'manage_reschedule', {
    p_token: req.token,
    p_new_starts_at: req.starts_at,
  })
  if (!moved.ok) return moved.response
  const result = parseResult(ctx.log, 'manage_reschedule', moved, ManageRescheduleResult)
  if (result === null) return internalErrorResponse()
  await send(ctx, result.message_ids)
  return json({
    appointment: {
      id: result.appointment_id,
      staff_id: result.staff_id,
      starts_at: result.starts_at,
      ends_at: result.ends_at,
    },
  } satisfies ManageRescheduleResponse)
}

function dispatch(ctx: Context, data: ManageRequest): Promise<Response> {
  switch (data.action) {
    case 'view':
      return view(ctx, data)
    case 'slots':
      return slots(ctx, data)
    case 'cancel':
      return cancel(ctx, data)
    case 'reschedule':
      return reschedule(ctx, data)
  }
}

export async function handleManage(req: Request, runtime: BookingRuntime): Promise<Response> {
  const proxy = requireProxy(req, runtime.proxySecret)
  if (!proxy.ok) return proxy.response
  const method = requireMethod(req, 'POST')
  if (!method.ok) return method.response
  if (runtime.services === null) return notConfiguredResponse()

  const body = await parseJsonBody(req, ManageRequest)
  if (!body.ok) return body.response

  let response: Response
  try {
    response = await dispatch({ ...runtime.services, log: runtime.log }, body.data)
  } catch {
    runtime.log('unhandled_error', { action: body.data.action })
    response = internalErrorResponse()
  }
  runtime.log('request', { action: body.data.action, status: response.status })
  return response
}
