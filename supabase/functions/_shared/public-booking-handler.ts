import { z, type ZodMiniType } from 'zod/mini'
import { isBase64UrlOfLength } from './base64url.ts'
import { otpCodeFor } from './booking-config.ts'
import {
  ClientsResponse,
  Grant,
  Id,
  Instant,
  ManageToken,
  NextVisitHint,
  OtpCode,
  PRIVACY_NOTICE_VERSION,
  PublicBookingRequest,
  TRUSTED_DEVICE_TOKEN_BYTES,
  VerifiedVia,
  type BookRequest,
  type BookResponse,
  type ClientsRequest,
  type ForgetResponse,
  type OtpSentResponse,
  type StartRequest,
  type TrustedResponse,
  type VerifyRequest,
  type VerifyResponse,
} from './booking-schemas.ts'
import {
  callRpc,
  domainErrorResponse,
  internalErrorResponse,
  type Log,
  type RpcOutcome,
} from './booking-rpc.ts'
import {
  notConfiguredResponse,
  type BookingRuntime,
  type BookingServices,
} from './booking-runtime.ts'
import { errorResponse, json, parseJsonBody, requireMethod, requireProxy } from './http.ts'
import { isUuid, PROXY_HEADERS } from './proxy-contract.ts'
import { sendMessages } from './send.ts'

/**
 * `POST /api/functions/v1/public-booking` (contract 1.3 §3–4): `start`, `verify`, `clients`,
 * `book`, `forget`. Pure (ADR-0002 §3): `public-booking/index.ts` builds the runtime from
 * `Deno.env` and serves every request through `handlePublicBooking`.
 *
 * Identical answers for known and unknown numbers (ADR-0006 §4): the OTP path of `start` never
 * looks at clients, and an unlisted recipient still gets `otp_sent`. The trusted-device token
 * travels only in the proxy's headers, never in a body.
 */

// ---------------------------------------------------------------------------------------------
// What the SQL returns (contract §2.6). Parsed before anything leaves the function.
// ---------------------------------------------------------------------------------------------

const TrustedDeviceToken = z
  .string()
  .check(z.refine((value) => isBase64UrlOfLength(value, TRUSTED_DEVICE_TOKEN_BYTES)))

const OtpStartResult = z.object({
  challenge_id: Id,
  message_id: Id,
  code: OtpCode,
  expires_at: Instant,
  resend_at: Instant,
})

const OtpVerifyResult = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('verified'),
    grant: Grant,
    grant_expires_at: Instant,
    trusted_device_token: TrustedDeviceToken,
  }),
  z.object({ result: z.literal('invalid'), attempts_left: z.optional(z.number()) }),
  z.object({ result: z.literal('expired') }),
  z.object({ result: z.literal('locked') }),
])

const BookAppointmentResult = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  total_cents: z.int().check(z.gte(0)),
  replayed: z.boolean(),
  verified_via: VerifiedVia,
  manage_token: ManageToken,
  message_ids: z.array(Id),
  next_visit_hint: z.nullable(NextVisitHint),
})

/** `otp_verify` never raises for the code outcome (decision 4); the function maps it. */
const OTP_FAILURE_CODES = { invalid: 'AN010', expired: 'AN011', locked: 'AN012' } as const

// ---------------------------------------------------------------------------------------------

type Context = BookingServices & {
  readonly log: Log
  readonly clientIp: string | null
  /** The trusted-device token of the business of this request, or null. */
  readonly td: string | null
}

/** The proxy forwards the cookie of `x-anaklo-business` only; anything malformed is absent. */
function trustedDeviceToken(headers: Headers): string | null {
  const value = headers.get(PROXY_HEADERS.trustedDevice)
  return value !== null && isBase64UrlOfLength(value, TRUSTED_DEVICE_TOKEN_BYTES) ? value : null
}

function invalidResult(log: Log, fn: string): Response {
  log('rpc_invalid_result', { fn })
  return internalErrorResponse()
}

function parseResult<T>(
  outcome: Extract<RpcOutcome, { ok: true }>,
  schema: ZodMiniType<T>,
): T | null {
  const parsed = schema.safeParse(outcome.data)
  return parsed.success ? parsed.data : null
}

async function start(ctx: Context, req: StartRequest): Promise<Response> {
  // A device that already proved this phone for this business skips the SMS (decision 6).
  if (ctx.td !== null) {
    const trusted = await callRpc(ctx.rpc, ctx.log, 'clients_for_phone', {
      p_business_id: req.business_id,
      p_phone: req.phone,
      p_grant: null,
      p_trusted_device_token: ctx.td,
    })
    if (trusted.ok) {
      const result = parseResult(trusted, ClientsResponse)
      if (result === null) return invalidResult(ctx.log, 'clients_for_phone')
      return json({ result: 'trusted', clients: result.clients } satisfies TrustedResponse)
    }
    // AN014: not trusted for this phone (another number, revoked, expired) → OTP as usual.
    if (trusted.code !== 'AN014') return trusted.response
  }

  const started = await callRpc(ctx.rpc, ctx.log, 'otp_start', {
    p_business_id: req.business_id,
    p_phone: req.phone,
    p_locale: req.locale,
    p_service_ids: req.service_ids,
    p_staff_id: req.staff_id,
    p_starts_at: req.starts_at,
    p_ip: ctx.clientIp,
    p_code: otpCodeFor(ctx.config, req.phone),
  })
  if (!started.ok) return started.response
  const otp = parseResult(started, OtpStartResult)
  if (otp === null) return invalidResult(ctx.log, 'otp_start')

  // The code exists only here (never stored in plaintext): it goes straight to the adapter.
  const outcomes = await sendMessages({
    rpc: ctx.rpc,
    provider: ctx.provider,
    config: ctx.config,
    ids: [otp.message_id],
    extraVars: { [otp.message_id]: { code: otp.code } },
    log: ctx.log,
  })
  const outcome = outcomes[otp.message_id]
  // `rejected` (a number outside SMS_ALLOWED_RECIPIENTS) answers like `sent`: same response
  // for every number. Not claimed or not sent: the page shows the business phone.
  if (outcome !== 'sent' && outcome !== 'rejected') {
    ctx.log('otp_not_sent', { message_id: otp.message_id, outcome: outcome ?? 'not_claimed' })
    return domainErrorResponse('AN017')
  }
  return json({
    result: 'otp_sent',
    challenge_id: otp.challenge_id,
    expires_at: otp.expires_at,
    resend_at: otp.resend_at,
  } satisfies OtpSentResponse)
}

async function verify(ctx: Context, req: VerifyRequest): Promise<Response> {
  const verified = await callRpc(ctx.rpc, ctx.log, 'otp_verify', {
    p_business_id: req.business_id,
    p_phone: req.phone,
    p_challenge_id: req.challenge_id,
    p_code: req.code,
  })
  if (!verified.ok) return verified.response
  const result = parseResult(verified, OtpVerifyResult)
  if (result === null) return invalidResult(ctx.log, 'otp_verify')

  ctx.log('otp_verify', { result: result.result })
  if (result.result !== 'verified') return domainErrorResponse(OTP_FAILURE_CODES[result.result])

  // The device token goes only into the response header: the proxy turns it into the
  // HttpOnly cookie and strips the header, so no page script ever sees it.
  const setTrustedDevice = { [PROXY_HEADERS.setTrustedDevice]: result.trusted_device_token }
  const clients = await callRpc(ctx.rpc, ctx.log, 'clients_for_phone', {
    p_business_id: req.business_id,
    p_phone: req.phone,
    p_grant: result.grant,
    p_trusted_device_token: null,
  })
  if (!clients.ok) {
    // The device is trusted all the same: a retried `start` then needs no new SMS.
    clients.response.headers.set(PROXY_HEADERS.setTrustedDevice, result.trusted_device_token)
    return clients.response
  }
  const list = parseResult(clients, ClientsResponse)
  if (list === null) {
    const response = invalidResult(ctx.log, 'clients_for_phone')
    response.headers.set(PROXY_HEADERS.setTrustedDevice, result.trusted_device_token)
    return response
  }
  return json(
    {
      grant: result.grant,
      grant_expires_at: result.grant_expires_at,
      clients: list.clients,
    } satisfies VerifyResponse,
    { headers: setTrustedDevice },
  )
}

async function clients(ctx: Context, req: ClientsRequest): Promise<Response> {
  const found = await callRpc(ctx.rpc, ctx.log, 'clients_for_phone', {
    p_business_id: req.business_id,
    p_phone: req.phone,
    p_grant: req.grant,
    p_trusted_device_token: ctx.td,
  })
  if (!found.ok) return found.response
  const result = parseResult(found, ClientsResponse)
  if (result === null) return invalidResult(ctx.log, 'clients_for_phone')
  return json({ verified_via: result.verified_via, clients: result.clients })
}

async function book(ctx: Context, req: BookRequest): Promise<Response> {
  const booked = await callRpc(ctx.rpc, ctx.log, 'book_appointment', {
    p_business_id: req.business_id,
    p_idempotency_key: req.idempotency_key,
    p_service_ids: req.service_ids,
    p_staff_id: req.staff_id,
    p_starts_at: req.starts_at,
    p_phone: req.phone,
    p_client_id: req.client.kind === 'existing' ? req.client.client_id : null,
    p_new_client:
      req.client.kind === 'new' ? { full_name: req.client.full_name, locale: req.locale } : null,
    p_grant: req.grant,
    p_trusted_device_token: ctx.td,
    p_marketing_box: req.marketing_box,
    // The notice the page showed, by version: from the code, never from the browser.
    p_policy_version: PRIVACY_NOTICE_VERSION,
  })
  if (!booked.ok) return booked.response
  const result = parseResult(booked, BookAppointmentResult)
  if (result === null) return invalidResult(ctx.log, 'book_appointment')

  // The booking has committed: a failed send is recorded and logged, never an error here.
  // A replay returns the still-queued ids again, which heals a confirmation never sent.
  await sendMessages({
    rpc: ctx.rpc,
    provider: ctx.provider,
    config: ctx.config,
    ids: result.message_ids,
    log: ctx.log,
  })

  return json({
    appointment: {
      id: result.appointment_id,
      staff_id: result.staff_id,
      starts_at: result.starts_at,
      ends_at: result.ends_at,
      total_cents: result.total_cents,
    },
    manage_token: result.manage_token,
    replayed: result.replayed,
    verified_via: result.verified_via,
    next_visit_hint: result.next_visit_hint,
  } satisfies BookResponse)
}

async function forget(ctx: Context, businessId: string): Promise<Response> {
  // An empty header value makes the proxy delete the cookie (Max-Age=0).
  const clearCookie = { [PROXY_HEADERS.setTrustedDevice]: '' }
  if (ctx.td !== null) {
    const revoked = await callRpc(ctx.rpc, ctx.log, 'trusted_device_revoke', {
      p_business_id: businessId,
      p_trusted_device_token: ctx.td,
    })
    if (!revoked.ok) {
      revoked.response.headers.set(PROXY_HEADERS.setTrustedDevice, '')
      return revoked.response
    }
  }
  return json({ forgotten: true } satisfies ForgetResponse, { headers: clearCookie })
}

function dispatch(ctx: Context, data: PublicBookingRequest): Promise<Response> {
  switch (data.action) {
    case 'start':
      return start(ctx, data)
    case 'verify':
      return verify(ctx, data)
    case 'clients':
      return clients(ctx, data)
    case 'book':
      return book(ctx, data)
    case 'forget':
      return forget(ctx, data.business_id)
  }
}

export async function handlePublicBooking(
  req: Request,
  runtime: BookingRuntime,
): Promise<Response> {
  const proxy = requireProxy(req, runtime.proxySecret)
  if (!proxy.ok) return proxy.response
  const method = requireMethod(req, 'POST')
  if (!method.ok) return method.response
  if (runtime.services === null) return notConfiguredResponse()

  const body = await parseJsonBody(req, PublicBookingRequest)
  if (!body.ok) return body.response
  const data = body.data

  // The proxy chose the trusted-device cookie by this header: it must be the body's business.
  const declared = req.headers.get(PROXY_HEADERS.business)
  if (!isUuid(declared) || declared.toLowerCase() !== data.business_id.toLowerCase()) {
    return errorResponse('business_mismatch', 'x-anaklo-business must equal business_id.', 400)
  }

  const ctx: Context = {
    ...runtime.services,
    log: runtime.log,
    clientIp: proxy.clientIp,
    td: trustedDeviceToken(req.headers),
  }
  let response: Response
  try {
    response = await dispatch(ctx, data)
  } catch {
    runtime.log('unhandled_error', { action: data.action })
    response = internalErrorResponse()
  }
  runtime.log('request', { action: data.action, status: response.status })
  return response
}
