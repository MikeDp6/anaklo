import { z } from 'zod/mini'
import { base64UrlLength } from './base64url.ts'
import { AppointmentStatus, Locale, VERIFIED_VIA } from './domain.ts'

/**
 * The HTTP contract of the Edge Functions `public-booking` and `manage` (step 1.3,
 * docs/plans/contracts/1.3-public-booking.md). One file, imported by both functions and by the
 * booking page, so the two sides can never drift. Pure (ADR-0002 §3): zod/mini only, no Deno,
 * DOM or Node APIs.
 *
 * Requests are strict (unknown keys → 400 `invalid_body`); responses are parsed leniently by the
 * page (extra keys are ignored), so the server may add fields without breaking old bundles.
 * The server re-validates everything in SQL; these schemas are the first gate, not the rule.
 */

// ---------------------------------------------------------------------------------------------
// Constants (the SQL of 0005 uses the same numbers; the server is authoritative)
// ---------------------------------------------------------------------------------------------

export const OTP_CODE_LENGTH = 6
/** Informational for the UI; the challenge row carries the real expiry. */
export const OTP_TTL_SECONDS = 300
export const OTP_MAX_ATTEMPTS = 5
export const GRANT_TTL_SECONDS = 600

/** Random bytes behind each token (≥ 128 bit, ADR-0006). */
export const GRANT_BYTES = 32
export const TRUSTED_DEVICE_TOKEN_BYTES = 32
export const MANAGE_TOKEN_BYTES = 16

/** Unpadded base64url lengths: 43, 43 and 22 characters. */
export const GRANT_LENGTH = base64UrlLength(GRANT_BYTES)
export const TRUSTED_DEVICE_TOKEN_LENGTH = base64UrlLength(TRUSTED_DEVICE_TOKEN_BYTES)
export const MANAGE_TOKEN_LENGTH = base64UrlLength(MANAGE_TOKEN_BYTES)

/** `businesses.short_code`, the `/r/<code>` link: 6 characters a-z0-9. */
export const SHORT_CODE_LENGTH = 6

/** D9: one service per online booking in Phase 1 (the SQL already accepts a list). */
export const MAX_SERVICES_PER_ONLINE_BOOKING = 1

/** Same bound as the `clients_name_unless_erased` CHECK. */
export const MAX_CLIENT_NAME_LENGTH = 120

/** At most this many clients are offered for one phone ("Κλείνεις ως …"). */
export const MAX_CLIENT_CHOICES = 20

/**
 * Version of the booking page's privacy notice (SPEC §11). The page shows the notice of this
 * version; the Edge Function (never the browser) writes it as `client_consents.policy_version`.
 * Bump it whenever the notice text changes. Matches the CHECK: 1–40 characters.
 */
export const PRIVACY_NOTICE_VERSION = 'booking-notice-2026-09-28'

/**
 * The marketing refusal box of the details step. `checked` = the client REFUSED marketing;
 * `unchecked` = shown and left alone (soft opt-in, ν. 3471/2006 άρ. 11§3); `not_shown` = no
 * record at all.
 */
export const MARKETING_BOX_STATES = ['not_shown', 'unchecked', 'checked'] as const

/** i18n keys (namespace `booking`) returned by `private.next_visit_hint_impl`. */
export const NEXT_VISIT_HINT_KEYS = ['nextVisit.business', 'nextVisit.vertical'] as const

export const PUBLIC_BOOKING_ACTIONS = ['start', 'verify', 'clients', 'book', 'forget'] as const
export const MANAGE_ACTIONS = ['view', 'slots', 'cancel', 'reschedule'] as const

const E164_PATTERN = /^\+[1-9]\d{7,14}$/
const OTP_CODE_PATTERN = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`)
const GRANT_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${GRANT_LENGTH}}$`)
const MANAGE_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${MANAGE_TOKEN_LENGTH}}$`)
const SHORT_CODE_PATTERN = new RegExp(`^[a-z0-9]{${SHORT_CODE_LENGTH}}$`)

/** `/m/<token>` (route.ts, Worker). */
export function isManageToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && MANAGE_TOKEN_PATTERN.test(value)
}

/** `/r/<code>` (route.ts, Worker). Lower case only: the SQL generates lower case. */
export function isShortCode(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHORT_CODE_PATTERN.test(value)
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** 8-4-4-4-12 hex, like `isUuid` of the proxy contract (Postgres ids, `crypto.randomUUID()`). */
export const Id = z.guid()
/** E.164 as produced by `phone.ts`; SQL narrows OTP to +3069 (AN018). */
export const PhoneE164 = z.string().check(z.regex(E164_PATTERN))
/** `businesses.currency` (ISO 4217, CHECK in 0001): prices are shown in it, never in a default. */
export const CurrencyCode = z.string().check(z.regex(/^[A-Z]{3}$/))
/** An instant with an explicit offset, as PostgREST prints timestamptz (`…+00:00`). */
export const Instant = z.iso.datetime({ offset: true })
/** A calendar date in the business time zone, `yyyy-MM-dd`. */
export const LocalDateString = z.iso.date()
/** A wall-clock time in the business time zone (`HH:mm` or `HH:mm:ss`, as Postgres prints `time`). */
export const LocalTimeString = z.iso.time()
export const OtpCode = z.string().check(z.regex(OTP_CODE_PATTERN))
/** The one-time verification grant (memory of the page only, never a cookie). */
export const Grant = z.string().check(z.regex(GRANT_PATTERN))
/** The manage-link token `/m/<token>`. */
export const ManageToken = z.string().check(z.regex(MANAGE_TOKEN_PATTERN))
export const ClientFullName = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(MAX_CLIENT_NAME_LENGTH))
export const MarketingBox = z.enum(MARKETING_BOX_STATES)
export const VerifiedVia = z.enum(VERIFIED_VIA)
const Cents = z.int().check(z.gte(0))
const ServiceIds = z.array(Id).check(z.minLength(1), z.maxLength(MAX_SERVICES_PER_ONLINE_BOOKING))

export type MarketingBox = z.infer<typeof MarketingBox>
export type VerifiedVia = z.infer<typeof VerifiedVia>

// ---------------------------------------------------------------------------------------------
// public-booking: POST /api/functions/v1/public-booking, body { action, … }
// Every request carries the header x-anaklo-business = business_id.
// ---------------------------------------------------------------------------------------------

/** The chosen slot, re-checked in SQL before any SMS (AN001). */
export const StartRequest = z.strictObject({
  action: z.literal('start'),
  business_id: Id,
  phone: PhoneE164,
  /** Language of the page: the OTP SMS and a new client's `clients.locale`. */
  locale: Locale,
  service_ids: ServiceIds,
  /** null = any staff member (only when `allow_any_staff`). */
  staff_id: z.nullable(Id),
  starts_at: Instant,
})

export const VerifyRequest = z.strictObject({
  action: z.literal('verify'),
  business_id: Id,
  phone: PhoneE164,
  challenge_id: Id,
  code: OtpCode,
})

/** With `grant: null` the trusted-device cookie (forwarded by the proxy) is the proof. */
export const ClientsRequest = z.strictObject({
  action: z.literal('clients'),
  business_id: Id,
  phone: PhoneE164,
  grant: z.nullable(Grant),
})

export const BookClient = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), client_id: Id }),
  z.strictObject({ kind: z.literal('new'), full_name: ClientFullName }),
])

export const BookRequest = z.strictObject({
  action: z.literal('book'),
  business_id: Id,
  /** One per booking attempt (`crypto.randomUUID()`), reused on every retry of that attempt. */
  idempotency_key: Id,
  phone: PhoneE164,
  locale: Locale,
  service_ids: ServiceIds,
  staff_id: z.nullable(Id),
  starts_at: Instant,
  /** The grant from `verify`; null when the trusted device is the proof. */
  grant: z.nullable(Grant),
  client: BookClient,
  marketing_box: MarketingBox,
})

/** Revokes the trusted device presented by the proxy and clears the cookie. */
export const ForgetRequest = z.strictObject({
  action: z.literal('forget'),
  business_id: Id,
})

export const PublicBookingRequest = z.discriminatedUnion('action', [
  StartRequest,
  VerifyRequest,
  ClientsRequest,
  BookRequest,
  ForgetRequest,
])

export const ClientChoice = z.object({
  id: Id,
  /** First word of `full_name` only: nothing else about a client leaves the server. */
  first_name: z.string(),
})

export const ClientChoices = z.array(ClientChoice).check(z.maxLength(MAX_CLIENT_CHOICES))

/** Identical for every number (known client or not): nothing here depends on `clients`. */
export const OtpSentResponse = z.object({
  result: z.literal('otp_sent'),
  challenge_id: Id,
  expires_at: Instant,
  /** Earliest instant a new `start` for this phone is accepted (AN019 before it). */
  resend_at: Instant,
})

/** The device already proved this phone for this business: no SMS was sent. */
export const TrustedResponse = z.object({
  result: z.literal('trusted'),
  clients: ClientChoices,
})

export const StartResponse = z.discriminatedUnion('result', [OtpSentResponse, TrustedResponse])

/** Sent with the response header x-anaklo-set-td (the proxy turns it into the cookie). */
export const VerifyResponse = z.object({
  grant: Grant,
  grant_expires_at: Instant,
  clients: ClientChoices,
})

export const ClientsResponse = z.object({
  verified_via: VerifiedVia,
  clients: ClientChoices,
})

export const NextVisitHint = z.object({
  key: z.enum(NEXT_VISIT_HINT_KEYS),
  weeks: z.int().check(z.gte(1), z.lte(52)),
})

export const BookedAppointment = z.object({
  id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  total_cents: Cents,
})

export const BookResponse = z.object({
  appointment: BookedAppointment,
  /** Returned once per call (a replay gets a NEW token); the page links to `/m/<token>`. */
  manage_token: ManageToken,
  replayed: z.boolean(),
  verified_via: VerifiedVia,
  next_visit_hint: z.nullable(NextVisitHint),
})

export const ForgetResponse = z.object({ forgotten: z.literal(true) })

// ---------------------------------------------------------------------------------------------
// manage: POST /api/functions/v1/manage, body { action, token, … }. Nothing changes on GET.
// ---------------------------------------------------------------------------------------------

export const ManageViewRequest = z.strictObject({
  action: z.literal('view'),
  token: ManageToken,
})

/** Free starts for a reschedule: same services, same staff member, the booking's own length. */
export const ManageSlotsRequest = z.strictObject({
  action: z.literal('slots'),
  token: ManageToken,
  from: LocalDateString,
  to: LocalDateString,
})

export const ManageCancelRequest = z.strictObject({
  action: z.literal('cancel'),
  token: ManageToken,
})

export const ManageRescheduleRequest = z.strictObject({
  action: z.literal('reschedule'),
  token: ManageToken,
  starts_at: Instant,
})

export const ManageRequest = z.discriminatedUnion('action', [
  ManageViewRequest,
  ManageSlotsRequest,
  ManageCancelRequest,
  ManageRescheduleRequest,
])

export const ManageBusiness = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
  locale: Locale,
  currency: CurrencyCode,
  phone_e164: z.nullable(PhoneE164),
  address: z.nullable(z.string()),
  maps_url: z.nullable(z.string()),
  /** Validated by `theme.ts` on the page, like the catalogue's. */
  theme: z.unknown(),
})

export const ManageService = z.object({
  id: Id,
  name: z.string(),
  duration_min: z.int().check(z.gte(1)),
  price_cents: Cents,
})

export const ManageAppointment = z.object({
  id: Id,
  status: AppointmentStatus,
  starts_at: Instant,
  ends_at: Instant,
  total_cents: Cents,
  staff: z.object({ id: Id, display_name: z.string() }),
  services: z.array(ManageService),
})

export const ManageViewResponse = z.object({
  business: ManageBusiness,
  appointment: ManageAppointment,
  /** Last instant a cancel/reschedule is accepted (cancel_min_notice_min and its exceptions). */
  change_until: Instant,
  can_cancel: z.boolean(),
  /** can_cancel and online booking still enabled. */
  can_reschedule: z.boolean(),
})

export const ManageSlot = z.object({
  starts_at: Instant,
  local_date: LocalDateString,
  local_time: LocalTimeString,
})

export const ManageSlotsResponse = z.object({ slots: z.array(ManageSlot) })

export const ManageCancelResponse = z.object({ status: z.literal('cancelled') })

export const ManageRescheduleResponse = z.object({
  appointment: z.object({ id: Id, staff_id: Id, starts_at: Instant, ends_at: Instant }),
})

// ---------------------------------------------------------------------------------------------
// Errors: one shape for the functions and the proxy (`_shared/http.ts`). The UI maps `code`
// through i18n (`errors.<code>` for AN0xx), never shows `message`.
// ---------------------------------------------------------------------------------------------

export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type StartRequest = z.infer<typeof StartRequest>
export type VerifyRequest = z.infer<typeof VerifyRequest>
export type ClientsRequest = z.infer<typeof ClientsRequest>
export type BookClient = z.infer<typeof BookClient>
export type BookRequest = z.infer<typeof BookRequest>
export type ForgetRequest = z.infer<typeof ForgetRequest>
export type PublicBookingRequest = z.infer<typeof PublicBookingRequest>
export type PublicBookingAction = (typeof PUBLIC_BOOKING_ACTIONS)[number]
export type ClientChoice = z.infer<typeof ClientChoice>
export type OtpSentResponse = z.infer<typeof OtpSentResponse>
export type TrustedResponse = z.infer<typeof TrustedResponse>
export type StartResponse = z.infer<typeof StartResponse>
export type VerifyResponse = z.infer<typeof VerifyResponse>
export type ClientsResponse = z.infer<typeof ClientsResponse>
export type NextVisitHint = z.infer<typeof NextVisitHint>
export type BookedAppointment = z.infer<typeof BookedAppointment>
export type BookResponse = z.infer<typeof BookResponse>
export type ForgetResponse = z.infer<typeof ForgetResponse>
export type ManageViewRequest = z.infer<typeof ManageViewRequest>
export type ManageSlotsRequest = z.infer<typeof ManageSlotsRequest>
export type ManageCancelRequest = z.infer<typeof ManageCancelRequest>
export type ManageRescheduleRequest = z.infer<typeof ManageRescheduleRequest>
export type ManageRequest = z.infer<typeof ManageRequest>
export type ManageAction = (typeof MANAGE_ACTIONS)[number]
export type ManageBusiness = z.infer<typeof ManageBusiness>
export type ManageService = z.infer<typeof ManageService>
export type ManageAppointment = z.infer<typeof ManageAppointment>
export type ManageViewResponse = z.infer<typeof ManageViewResponse>
export type ManageSlot = z.infer<typeof ManageSlot>
export type ManageSlotsResponse = z.infer<typeof ManageSlotsResponse>
export type ManageCancelResponse = z.infer<typeof ManageCancelResponse>
export type ManageRescheduleResponse = z.infer<typeof ManageRescheduleResponse>
export type ErrorBody = z.infer<typeof ErrorBody>
