import {
  BookResponse,
  ClientsResponse,
  ForgetResponse,
  StartResponse,
  VerifyResponse,
  type BookRequest,
  type ClientsRequest,
  type StartRequest,
  type VerifyRequest,
} from '@fn-shared/booking-schemas.ts'
import { PROXY_HEADERS } from '@fn-shared/proxy-contract.ts'
import type { ZodMiniType } from 'zod/mini'
import { postPublicApi } from '@/shared/lib/publicApi'

/**
 * `POST /api/functions/v1/public-booking` (contract 1.3 §4). Every call names its business in
 * `x-anaklo-business`: the proxy forwards the trusted-device cookie of that business only. The
 * grant lives in the page's memory only; the device token never reaches a script (HttpOnly).
 */
const PATH = '/functions/v1/public-booking'

function call<T>(businessId: string, body: object, schema: ZodMiniType<T>): Promise<T> {
  return postPublicApi(PATH, body, schema, {
    headers: { [PROXY_HEADERS.business]: businessId },
  })
}

type Body<T extends { action: string }> = Omit<T, 'action'>

export function startVerification(request: Body<StartRequest>) {
  return call(request.business_id, { action: 'start', ...request }, StartResponse)
}

/** Never called twice at once for one challenge: a second call would answer AN011. */
export function verifyCode(request: Body<VerifyRequest>) {
  return call(request.business_id, { action: 'verify', ...request }, VerifyResponse)
}

export function fetchClients(request: Body<ClientsRequest>) {
  return call(request.business_id, { action: 'clients', ...request }, ClientsResponse)
}

/** A retry sends the identical body (same idempotency key): the server replays the booking. */
export function bookAppointment(request: Body<BookRequest>) {
  return call(request.business_id, { action: 'book', ...request }, BookResponse)
}

/** Revokes this device's trust for the business and deletes the cookie (ADR-0006). */
export function forgetDevice(businessId: string) {
  return call(businessId, { action: 'forget', business_id: businessId }, ForgetResponse)
}
