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
/** Who wrote an audit row; 'import' since 0010 (merge_clients_core with the importer's actor). */
export const AUDIT_ACTOR_TYPES = ['staff', 'nous_support', 'system', 'import'] as const
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
  /** To the owners when an authenticator device of a member changed without approval (0011). */
  'push_security_alert',
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

/**
 * Jobs that write a heartbeat to `private.job_runs` (0006, 0007, 0011) and that `health` watches
 * (`private.health_jobs`, 0011).
 */
export const JOB_NAMES = [
  'auto_complete',
  'dispatch_sweep',
  'dispatch',
  'purge',
  'detect_factor_changes',
] as const

/**
 * `private.factor_change_grants` (0009): the permission for one change of a user's devices of the
 * authenticator app. `add` has no factor id (not known yet); `remove` names the factor.
 */
export const FACTOR_GRANT_ACTIONS = ['add', 'remove'] as const
/** Who allowed it: the user (fresh code), Nous (mfa-reset), a demotion/removal, the 1.9 reaction. */
export const FACTOR_GRANT_SOURCES = ['user', 'nous_support', 'demotion', 'system'] as const

/**
 * `private.security_events` (0011): a change of a user's authenticator devices that no grant
 * matched, and its handling by `dispatch` (containment until done, notifications at most once).
 */
export const SECURITY_EVENT_KINDS = [
  'factor_added_unauthorized',
  'factor_removed_unauthorized',
] as const
export const SECURITY_EVENT_STATUSES = ['pending', 'containing', 'notifying', 'done'] as const
/** How a finished event ended: notified, or the lease was lost while notifying (never re-sent). */
export const SECURITY_EVENT_RESULTS = ['notified', 'notify_unknown'] as const

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
/**
 * The two hints of `42501` from `private.require_fresh_totp()` (0009): the only ones that open
 * the code sheet (one retry of the call). Any other `42501` is a plain refusal.
 */
export const STEP_UP_HINTS = ['aal2_required', 'fresh_totp_required'] as const
/** What Nous records through `record_support_action` (0009, service_role only). */
export const SUPPORT_ACTIONS = ['mfa_reset', 'provision_update'] as const
/**
 * RPC outputs of 0010 (contract 1.8 §2.8; domain.test.ts checks that 0010 names them). The three
 * states of `client_card`: the card of a family, a merged source (the app redirects to the root),
 * an erased client (the state only).
 */
export const CLIENT_CARD_STATES = ['live', 'merged', 'erased'] as const
/** The E18 ring of `client_card`: days since the last visit against the next-visit interval. */
export const RING_STATES = ['no_visits', 'no_interval', 'within', 'beyond'] as const
/** A family's consent per purpose (`private.consent_state`): the latest active record wins. */
export const CONSENT_STATES = ['granted', 'refused', 'none'] as const
/**
 * RPC outputs of 0011 (contract 1.9 §2.9; domain.test.ts checks that 0011 names them). The checks
 * of `health`: one per watched job and the oldest unfinished security event.
 */
export const HEALTH_CHECK_NAMES = [...JOB_NAMES, 'security_events'] as const
/** Who an email of `record_security_event_result` (contained) goes to: the account, its owners. */
export const SECURITY_EMAIL_AUDIENCES = ['user', 'owner'] as const

export const Vertical = z.enum(VERTICALS)
export const Locale = z.enum(LOCALES)
export const MemberRole = z.enum(MEMBER_ROLES)
export const AppointmentStatus = z.enum(APPOINTMENT_STATUSES)
export const AppointmentSource = z.enum(APPOINTMENT_SOURCES)
export const CancelReason = z.enum(CANCEL_REASONS)
export const ConflictReason = z.enum(CONFLICT_REASONS)
export const ReassignBlocker = z.enum(REASSIGN_BLOCKERS)
export const StepUpHint = z.enum(STEP_UP_HINTS)
export const SupportAction = z.enum(SUPPORT_ACTIONS)
export const ConsentPurpose = z.enum(CONSENT_PURPOSES)
export const ConsentState = z.enum(CONSENT_STATES)
export const RingState = z.enum(RING_STATES)
export const ClientCardState = z.enum(CLIENT_CARD_STATES)
export const SecurityEventKind = z.enum(SECURITY_EVENT_KINDS)
export const HealthCheckName = z.enum(HEALTH_CHECK_NAMES)
export const SecurityEmailAudience = z.enum(SECURITY_EMAIL_AUDIENCES)

export type Vertical = z.infer<typeof Vertical>
export type Locale = z.infer<typeof Locale>
export type MemberRole = z.infer<typeof MemberRole>
export type AppointmentStatus = z.infer<typeof AppointmentStatus>
export type AppointmentSource = z.infer<typeof AppointmentSource>
export type CancelReason = z.infer<typeof CancelReason>
export type ConflictReason = z.infer<typeof ConflictReason>
export type ReassignBlocker = z.infer<typeof ReassignBlocker>
export type StepUpHint = z.infer<typeof StepUpHint>
export type SupportAction = z.infer<typeof SupportAction>
export type ConsentPurpose = z.infer<typeof ConsentPurpose>
export type ConsentState = z.infer<typeof ConsentState>
export type RingState = z.infer<typeof RingState>
export type ClientCardState = z.infer<typeof ClientCardState>
export type SecurityEventKind = z.infer<typeof SecurityEventKind>
export type HealthCheckName = z.infer<typeof HealthCheckName>
export type SecurityEmailAudience = z.infer<typeof SecurityEmailAudience>

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
  factor_change_grants_action: FACTOR_GRANT_ACTIONS,
  factor_change_grants_source: FACTOR_GRANT_SOURCES,
  health_jobs_job: JOB_NAMES,
  security_events_kind: SECURITY_EVENT_KINDS,
  security_events_status: SECURITY_EVENT_STATUSES,
  security_events_result: SECURITY_EVENT_RESULTS,
}
