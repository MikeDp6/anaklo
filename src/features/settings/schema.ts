import { z } from 'zod/mini'
import { CurrencyCode, Id, Instant, LocalDateString } from '@fn-shared/booking-schemas.ts'
import { toHm } from '@fn-shared/hours.ts'
import {
  AppointmentSource,
  ConflictReason,
  EXCEPTION_KINDS,
  Locale,
  ReassignBlocker,
  REMINDER_MODES,
  TIME_OFF_REASONS,
} from '@/shared/lib/domain'
import type { LocalDate } from '@/shared/lib/dates'

/** The `businesses` columns the pro app reads for its day screens (contract 1.4 §3.1). */
export const BusinessRow = z.object({
  id: Id,
  name: z.string(),
  timezone: z.string(),
  currency: CurrencyCode,
  locale: Locale,
  slot_step_min: z.int().check(z.gte(1)),
  correction_window_days: z.int().check(z.gte(0)),
})

export interface Business {
  readonly id: string
  readonly name: string
  readonly timeZone: string
  readonly currency: string
  readonly locale: Locale
  readonly slotStepMin: number
  readonly correctionWindowDays: number
}

export function toBusiness(row: z.infer<typeof BusinessRow>): Business {
  return {
    id: row.id,
    name: row.name,
    timeZone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    slotStepMin: row.slot_step_min,
    correctionWindowDays: row.correction_window_days,
  }
}

// ---------------------------------------------------------------------------------------------
// Settings screens of 1.6 (contract 1.6 §3.2). Responses are parsed leniently (extra keys are
// ignored); times come back as Postgres `time` (`'22:00:00'`) and are shown as `HH:MM` (`toHm`).
// ---------------------------------------------------------------------------------------------

/** `'HH:MM'`; an end may be `'24:00'` (stored by provisioning, never produced by the UI). */
export type Hm = string
export type Instant = string

export const TimeOffReason = z.enum(TIME_OFF_REASONS)
export type TimeOffReason = z.infer<typeof TimeOffReason>
export const ReminderMode = z.enum(REMINDER_MODES)
export type ReminderMode = z.infer<typeof ReminderMode>
export const ExceptionKind = z.enum(EXCEPTION_KINDS)
export type ExceptionKind = z.infer<typeof ExceptionKind>

/** A Postgres `time` as PostgREST prints it (`HH:MM:SS`, also `24:00:00`). */
const DbTime = z.string().check(z.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)(:[0-5]\d)?$/))

// ---------------------------------------------------------------------------------------------
// Booking policy (businesses)
// ---------------------------------------------------------------------------------------------

/** What `fetchBookingPolicy` reads and `updateBookingPolicy` returns (contract 1.6 §3.1). */
export const POLICY_COLUMNS =
  'id, timezone, booking_enabled, slot_step_min, min_notice_min, max_advance_days, cancel_min_notice_min, auto_complete_after_min, correction_window_days, allow_any_staff, messaging_enabled, quiet_start, quiet_end, reminder_mode'

export const BookingPolicyRow = z.object({
  id: Id,
  timezone: z.string(),
  booking_enabled: z.boolean(),
  slot_step_min: z.int(),
  min_notice_min: z.int(),
  max_advance_days: z.int(),
  cancel_min_notice_min: z.int(),
  auto_complete_after_min: z.int(),
  correction_window_days: z.int(),
  allow_any_staff: z.boolean(),
  messaging_enabled: z.boolean(),
  quiet_start: DbTime,
  quiet_end: DbTime,
  reminder_mode: ReminderMode,
})

export interface BookingPolicy {
  readonly id: string
  readonly timeZone: string
  readonly bookingEnabled: boolean
  readonly slotStepMin: number
  readonly minNoticeMin: number
  readonly maxAdvanceDays: number
  readonly cancelMinNoticeMin: number
  readonly autoCompleteAfterMin: number
  readonly correctionWindowDays: number
  readonly allowAnyStaff: boolean
  readonly messagingEnabled: boolean
  readonly quietStart: Hm
  readonly quietEnd: Hm
  readonly reminderMode: ReminderMode
}

export function toBookingPolicy(row: z.infer<typeof BookingPolicyRow>): BookingPolicy {
  return {
    id: row.id,
    timeZone: row.timezone,
    bookingEnabled: row.booking_enabled,
    slotStepMin: row.slot_step_min,
    minNoticeMin: row.min_notice_min,
    maxAdvanceDays: row.max_advance_days,
    cancelMinNoticeMin: row.cancel_min_notice_min,
    autoCompleteAfterMin: row.auto_complete_after_min,
    correctionWindowDays: row.correction_window_days,
    allowAnyStaff: row.allow_any_staff,
    messagingEnabled: row.messaging_enabled,
    quietStart: toHm(row.quiet_start),
    quietEnd: toHm(row.quiet_end),
    reminderMode: row.reminder_mode,
  }
}

/** Every editable column of the policy (the screen sends them all; the server keeps the rest). */
export type BookingPolicyInput = Omit<BookingPolicy, 'id' | 'timeZone'>

// ---------------------------------------------------------------------------------------------
// schedule_exceptions (closures and special hours)
// ---------------------------------------------------------------------------------------------

export const ExceptionRows = z.array(
  z.object({
    id: Id,
    staff_id: z.nullable(Id),
    local_date: LocalDateString,
    kind: ExceptionKind,
    start_time: z.nullable(DbTime),
    end_time: z.nullable(DbTime),
    note: z.nullable(z.string()),
  }),
)

export interface ScheduleException {
  readonly id: string
  /** null = the whole shop. */
  readonly staffId: string | null
  readonly localDate: LocalDate
  readonly kind: ExceptionKind
  readonly startTime: Hm | null
  readonly endTime: Hm | null
  readonly note: string | null
}

export function toExceptions(rows: z.infer<typeof ExceptionRows>): ScheduleException[] {
  return rows.map((row) => ({
    id: row.id,
    staffId: row.staff_id,
    localDate: row.local_date,
    kind: row.kind,
    startTime: row.start_time === null ? null : toHm(row.start_time),
    endTime: row.end_time === null ? null : toHm(row.end_time),
    note: row.note,
  }))
}

/** A new exception row as `addExceptions` inserts it (client-generated id, contract 1.6 D17). */
export type NewException = ScheduleException

// ---------------------------------------------------------------------------------------------
// time_off
// ---------------------------------------------------------------------------------------------

export const TimeOffRows = z.array(
  z.object({
    id: Id,
    staff_id: Id,
    starts_at: Instant,
    ends_at: Instant,
    reason: TimeOffReason,
  }),
)

export interface TimeOff {
  readonly id: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly reason: TimeOffReason
}

export function toTimeOff(rows: z.infer<typeof TimeOffRows>): TimeOff[] {
  return rows.map((row) => ({
    id: row.id,
    staffId: row.staff_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    reason: row.reason,
  }))
}

/** `isNew`: an insert with the form's id (ignored if it exists); else an update of that row. */
export interface TimeOffInput extends TimeOff {
  readonly isNew: boolean
}

// ---------------------------------------------------------------------------------------------
// schedule_conflicts, mark_absence, reassign_candidates
// ---------------------------------------------------------------------------------------------

/** null = the server's default (from: now; to: 366 days after `from`). */
export interface ConflictsQuery {
  readonly staffId: string | null
  readonly from: Instant | null
  readonly to: Instant | null
}

const ConflictRow = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  status: z.enum(['booked', 'confirmed']),
  source: AppointmentSource,
  client_id: z.nullable(Id),
  client_name: z.nullable(z.string()),
  client_phone_e164: z.nullable(z.string()),
  service_ids: z.array(Id),
  reasons: z.array(ConflictReason),
})

export const ConflictRows = z.array(ConflictRow)

export interface ScheduleConflict {
  readonly appointmentId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly status: 'booked' | 'confirmed'
  readonly source: AppointmentSource
  readonly clientId: string | null
  /** null for a walk-in without a client or an erased client. */
  readonly clientName: string | null
  readonly clientPhoneE164: string | null
  readonly serviceIds: readonly string[]
  readonly reasons: readonly ConflictReason[]
}

export function toConflicts(rows: z.infer<typeof ConflictRows>): ScheduleConflict[] {
  return rows.map((row) => ({
    appointmentId: row.appointment_id,
    staffId: row.staff_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    source: row.source,
    clientId: row.client_id,
    clientName: row.client_name,
    clientPhoneE164: row.client_phone_e164,
    serviceIds: row.service_ids,
    reasons: row.reasons,
  }))
}

export interface AbsenceInput {
  readonly staffId: string
  readonly from: Instant
  readonly to: Instant
}

export const AbsenceResponse = z.object({
  time_off_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  reason: TimeOffReason,
  created: z.boolean(),
  extended: z.boolean(),
  conflicts: ConflictRows,
})

export interface AbsenceResult {
  readonly timeOffId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly reason: TimeOffReason
  readonly created: boolean
  readonly extended: boolean
  readonly conflicts: readonly ScheduleConflict[]
}

export function toAbsenceResult(response: z.infer<typeof AbsenceResponse>): AbsenceResult {
  return {
    timeOffId: response.time_off_id,
    staffId: response.staff_id,
    startsAt: response.starts_at,
    endsAt: response.ends_at,
    reason: response.reason,
    created: response.created,
    extended: response.extended,
    conflicts: toConflicts(response.conflicts),
  }
}

export const ReassignRows = z.array(
  z.object({ staff_id: Id, free: z.boolean(), blocker: z.nullable(ReassignBlocker) }),
)

export interface ReassignCandidate {
  readonly staffId: string
  readonly free: boolean
  readonly blocker: ReassignBlocker | null
}

export function toCandidates(rows: z.infer<typeof ReassignRows>): ReassignCandidate[] {
  return rows.map((row) => ({ staffId: row.staff_id, free: row.free, blocker: row.blocker }))
}

/**
 * «Ανάθεση: …» of a conflict row (`reassign_appointment`, review fix of 1.6): the colleague takes
 * the appointment at the same time only while it is still with `expectedStaffId` at
 * `expectedStartsAt` (the row the owner saw); otherwise AN021 and nothing changes. One idempotency
 * key per attempt (same payload → same key), as `staff_move_appointment`.
 */
export interface ReassignInput {
  readonly appointmentId: string
  readonly idempotencyKey: string
  readonly expectedStaffId: string
  readonly expectedStartsAt: Instant
  readonly newStaffId: string
  readonly notify: boolean
}

// ---------------------------------------------------------------------------------------------
// Business identity (contract 1.7 §6.9): slug, time zone, currency
// ---------------------------------------------------------------------------------------------

/** The fields `change_business_identity` changes, in the order its answer lists them. */
export const IDENTITY_FIELDS = ['slug', 'timezone', 'currency'] as const
export const IdentityField = z.enum(IDENTITY_FIELDS)
export type IdentityField = z.infer<typeof IdentityField>

export const IdentityRow = z.object({
  id: Id,
  slug: z.string(),
  timezone: z.string(),
  currency: CurrencyCode,
})

/** Former slugs that still lead here (`business_slug_aliases`), newest first. */
export const AliasRows = z.array(z.object({ slug: z.string() }))

export interface IdentityValues {
  readonly slug: string
  readonly timeZone: string
  readonly currency: string
}

export interface BusinessIdentity extends IdentityValues {
  readonly id: string
  readonly aliases: readonly string[]
}

export function toIdentity(
  row: z.infer<typeof IdentityRow>,
  aliases: z.infer<typeof AliasRows>,
): BusinessIdentity {
  return {
    id: row.id,
    slug: row.slug,
    timeZone: row.timezone,
    currency: row.currency,
    aliases: aliases.map((alias) => alias.slug),
  }
}

/** Only what changes; a field left out stays as it is (the RPC's `null`). */
export interface IdentityChange {
  readonly slug?: string
  readonly timeZone?: string
  readonly currency?: string
}

/** `change_business_identity`'s answer; `changed: false` = nothing was different (D9). */
export const IdentityResponse = z.object({
  business_id: Id,
  slug: z.string(),
  timezone: z.string(),
  currency: CurrencyCode,
  changed: z.boolean(),
  changed_fields: z.array(IdentityField),
})

export interface IdentityResult {
  /** What the server stored (the form is refilled from it). */
  readonly stored: IdentityValues
  readonly changed: boolean
  readonly changedFields: readonly IdentityField[]
}

export function toIdentityResult(response: z.infer<typeof IdentityResponse>): IdentityResult {
  return {
    stored: { slug: response.slug, timeZone: response.timezone, currency: response.currency },
    changed: response.changed,
    changedFields: response.changed_fields,
  }
}
