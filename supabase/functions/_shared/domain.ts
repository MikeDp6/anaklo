import { z } from 'zod/mini'

/**
 * Value lists that the database enforces with text + CHECK constraints (SPEC §7).
 * `supabase gen types` turns those columns into plain `string`, so the app narrows them with
 * these lists. domain.test.ts fails if a list and its CHECK constraint ever disagree.
 */

export const VERTICALS = ['barber', 'hair_salon', 'beauty'] as const
export const LOCALES = ['el', 'en'] as const
export const MEMBER_ROLES = ['owner', 'manager', 'staff'] as const
export const EXCEPTION_KINDS = ['closed', 'open'] as const
/** Neutral on purpose: no value may reveal health data (GDPR art. 9). */
export const TIME_OFF_REASONS = ['vacation', 'leave', 'personal', 'other'] as const
export const CLIENT_SOURCES = ['online', 'staff', 'import'] as const
export const CONSENT_PURPOSES = [
  'marketing_sms',
  'marketing_email',
  'photos_record',
  'photos_publish',
] as const
export const LEGAL_BASES = ['consent', 'soft_opt_in'] as const
export const CONSENT_SOURCES = ['booking_form', 'staff_ui', 'import', 'link'] as const
export const CONSENT_GIVEN_BY = ['client', 'guardian'] as const
export const APPOINTMENT_STATUSES = [
  'booked',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
] as const
export const APPOINTMENT_SOURCES = ['online', 'phone', 'walkin', 'staff', 'import'] as const
/** How the client of an online booking proved the phone (ADR-0006). */
export const VERIFIED_VIA = ['otp', 'trusted_device'] as const
export const CANCELLED_BY = ['client', 'business', 'system'] as const
export const CANCEL_REASONS = [
  'client_request',
  'staff_unavailable',
  'shop_closed',
  'rescheduled',
  'duplicate',
  'other',
] as const
export const APPOINTMENT_EVENTS = [
  'created',
  'status_changed',
  'rescheduled',
  'reassigned',
  'imported',
] as const
export const EVENT_ACTOR_TYPES = ['client', 'staff', 'system', 'import'] as const
export const AUDIT_ACTOR_TYPES = ['staff', 'nous_support', 'system'] as const
/** The outbox, `messages_log` (0005, 0007). */
export const MESSAGE_CHANNELS = ['sms', 'push'] as const
/** SMS templates: exactly the keys of SMS_TEMPLATES in sms-templates.ts (domain.test.ts). */
export const SMS_MESSAGE_TEMPLATES = [
  'otp',
  'booking_confirmed',
  'reminder',
  'cancelled_by_client',
  'cancelled_by_business',
  'rescheduled_by_client',
  'rescheduled_by_business',
] as const
/** Push templates (staff only): exactly the keys of PUSH_TEMPLATES in push-templates.ts. */
export const PUSH_MESSAGE_TEMPLATES = [
  'push_booking_created',
  'push_booking_cancelled',
  'push_booking_moved',
  'push_test',
] as const
export const MESSAGE_TEMPLATES = [...SMS_MESSAGE_TEMPLATES, ...PUSH_MESSAGE_TEMPLATES] as const
export const MESSAGE_CATEGORIES = ['otp', 'transactional', 'reminder', 'marketing'] as const
export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'cancelled',
  'unknown',
] as const
export const SUPPRESSION_REASONS = ['erased', 'opted_out'] as const
/** Why a manage-link token was issued: the booking answer or a message. */
export const BOOKING_TOKEN_ISSUERS = ['booking', 'message'] as const
export const RATE_LIMIT_BUCKETS = [
  'otp_phone_hour',
  'otp_ip_hour',
  'otp_business_day',
  'sms_platform_day',
  /** SMS other than OTP, per recipient phone / per business (claim_messages). */
  'sms_phone_day',
  'sms_business_day',
  /** Every SMS of the platform per UTC calendar month, counted at claim (0007). */
  'sms_platform_month',
] as const
/** Staff push devices, `push_subscriptions` (ADR-0010 §2). */
export const PUSH_PROVIDERS = ['onesignal', 'vapid'] as const
/** When the reminder goes out (SPEC §12): 24 h before, or 18:00 local the evening before. */
export const REMINDER_MODES = ['24h', 'evening_before'] as const

/** Jobs that write a heartbeat to `private.job_runs` (0006, 0007; 1.9 health reads them). */
export const JOB_NAMES = ['auto_complete', 'dispatch_sweep', 'dispatch', 'purge'] as const

/**
 * RPC outputs, not CHECK lists (so not in CHECKED_VALUE_LISTS; domain.test.ts checks that 0008
 * names them). Why an appointment no longer fits the schedule (`schedule_conflicts`, 0008), in
 * the order the server lists them. Reason codes only: never the reason of a time off.
 */
export const CONFLICT_REASONS = [
  'shop_closed',
  'staff_closed',
  'time_off',
  'special_hours',
  'outside_hours',
  'staff_inactive',
] as const
/** Why a colleague cannot take an appointment at its time (`reassign_candidates`, 0008). */
export const REASSIGN_BLOCKERS = ['not_offered', 'busy', 'off', 'tight'] as const

export const Vertical = z.enum(VERTICALS)
export const Locale = z.enum(LOCALES)
export const MemberRole = z.enum(MEMBER_ROLES)
export const AppointmentStatus = z.enum(APPOINTMENT_STATUSES)
export const AppointmentSource = z.enum(APPOINTMENT_SOURCES)
export const CancelReason = z.enum(CANCEL_REASONS)
export const ConflictReason = z.enum(CONFLICT_REASONS)
export const ReassignBlocker = z.enum(REASSIGN_BLOCKERS)

export type Vertical = z.infer<typeof Vertical>
export type Locale = z.infer<typeof Locale>
export type MemberRole = z.infer<typeof MemberRole>
export type AppointmentStatus = z.infer<typeof AppointmentStatus>
export type AppointmentSource = z.infer<typeof AppointmentSource>
export type CancelReason = z.infer<typeof CancelReason>
export type ConflictReason = z.infer<typeof ConflictReason>
export type ReassignBlocker = z.infer<typeof ReassignBlocker>

/** CHECK constraint name → the list above that must match it exactly (order-insensitive). */
export const CHECKED_VALUE_LISTS: Readonly<Record<string, readonly string[]>> = {
  businesses_vertical: VERTICALS,
  businesses_locale: LOCALES,
  businesses_reminder_mode: REMINDER_MODES,
  business_members_role: MEMBER_ROLES,
  schedule_exceptions_kind: EXCEPTION_KINDS,
  time_off_reason: TIME_OFF_REASONS,
  clients_locale: LOCALES,
  clients_source: CLIENT_SOURCES,
  client_consents_purpose: CONSENT_PURPOSES,
  client_consents_legal_basis: LEGAL_BASES,
  client_consents_source: CONSENT_SOURCES,
  client_consents_given_by: CONSENT_GIVEN_BY,
  appointments_status: APPOINTMENT_STATUSES,
  appointments_source: APPOINTMENT_SOURCES,
  appointments_verified_via: VERIFIED_VIA,
  appointments_cancelled_by: CANCELLED_BY,
  appointments_cancel_reason: CANCEL_REASONS,
  appointment_events_event: APPOINTMENT_EVENTS,
  appointment_events_actor_type: EVENT_ACTOR_TYPES,
  audit_log_actor_type: AUDIT_ACTOR_TYPES,
  messages_log_channel: MESSAGE_CHANNELS,
  messages_log_locale: LOCALES,
  messages_log_template: MESSAGE_TEMPLATES,
  messages_log_category: MESSAGE_CATEGORIES,
  messages_log_status: MESSAGE_STATUSES,
  booking_tokens_issued_for: BOOKING_TOKEN_ISSUERS,
  rate_limits_bucket: RATE_LIMIT_BUCKETS,
  suppression_list_reason: SUPPRESSION_REASONS,
  vertical_defaults_vertical: VERTICALS,
  job_runs_job: JOB_NAMES,
  push_subscriptions_provider: PUSH_PROVIDERS,
}
