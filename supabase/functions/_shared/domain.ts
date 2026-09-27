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

export const Vertical = z.enum(VERTICALS)
export const Locale = z.enum(LOCALES)
export const MemberRole = z.enum(MEMBER_ROLES)
export const AppointmentStatus = z.enum(APPOINTMENT_STATUSES)
export const AppointmentSource = z.enum(APPOINTMENT_SOURCES)
export const CancelReason = z.enum(CANCEL_REASONS)

export type Vertical = z.infer<typeof Vertical>
export type Locale = z.infer<typeof Locale>
export type MemberRole = z.infer<typeof MemberRole>
export type AppointmentStatus = z.infer<typeof AppointmentStatus>
export type AppointmentSource = z.infer<typeof AppointmentSource>
export type CancelReason = z.infer<typeof CancelReason>

/** CHECK constraint name → the list above that must match it exactly (order-insensitive). */
export const CHECKED_VALUE_LISTS: Readonly<Record<string, readonly string[]>> = {
  businesses_vertical: VERTICALS,
  businesses_locale: LOCALES,
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
}
