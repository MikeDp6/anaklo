import { z } from 'zod/mini'
import {
  CurrencyCode,
  Id,
  Instant,
  LocalDateString,
  LocalTimeString,
} from '@fn-shared/booking-schemas.ts'
import {
  AppointmentSource,
  AppointmentStatus,
  CancelReason,
  CANCELLED_BY,
  type Locale,
} from '@/shared/lib/domain'
import type { LocalDate, LocalTime } from '@/shared/lib/localDates'

/**
 * Responses of the day-operation RPCs and reads (contract 1.4 §2.6, §3.4). Parsed leniently:
 * extra keys are ignored, so the server may add fields without breaking an installed app.
 * The api.ts functions map snake_case to the camelCase types below.
 */

const Minutes = z.int().check(z.gte(0))
const Cents = z.int().check(z.gte(0))
const Count = z.int().check(z.gte(0))

export const BOOKING_WARNINGS = ['outside_hours', 'buffer_overlap'] as const
export const BookingWarning = z.enum(BOOKING_WARNINGS)
export type BookingWarning = z.infer<typeof BookingWarning>

/** `set_appointment_status` accepts only these; cancelling goes through `cancel_appointment`. */
export const STATUS_TARGETS = ['confirmed', 'completed', 'no_show'] as const
export type StatusTarget = (typeof STATUS_TARGETS)[number]

export type Instant = string

// ---------------------------------------------------------------------------------------------
// busy_calendar
// ---------------------------------------------------------------------------------------------

export const DayFrameResponse = z.object({
  local_date: LocalDateString,
  timezone: z.string(),
  day_start: Instant,
  day_end: Instant,
  windows: z.array(z.object({ staff_id: Id, starts_at: Instant, ends_at: Instant })),
  blocks: z.array(
    z.object({
      appointment_id: Id,
      staff_id: Id,
      starts_at: Instant,
      ends_at: Instant,
      buffer_after_min: Minutes,
    }),
  ),
})

export interface WorkingWindow {
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
}

export interface BusyBlock {
  readonly appointmentId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly bufferAfterMin: number
}

export interface DayFrame {
  readonly localDate: LocalDate
  readonly timeZone: string
  readonly dayStart: Instant
  readonly dayEnd: Instant
  readonly windows: readonly WorkingWindow[]
  readonly blocks: readonly BusyBlock[]
}

// ---------------------------------------------------------------------------------------------
// appointments (RLS select of one staff member's day)
// ---------------------------------------------------------------------------------------------

export const DayAppointmentRows = z.array(
  z.object({
    id: Id,
    staff_id: Id,
    client_id: z.nullable(Id),
    starts_at: Instant,
    ends_at: Instant,
    buffer_after_min: Minutes,
    status: AppointmentStatus,
    source: AppointmentSource,
    total_cents: Cents,
    cancel_reason: z.nullable(CancelReason),
    client: z.nullable(
      z.object({
        id: Id,
        full_name: z.string(),
        phone_e164: z.nullable(z.string()),
        erased_at: z.nullable(Instant),
      }),
    ),
    services: z.array(
      z.object({
        position: z.int(),
        service_id: Id,
        duration_min: Minutes,
        price_cents: Cents,
      }),
    ),
  }),
)

type DayAppointmentRow = z.infer<typeof DayAppointmentRows>[number]

/**
 * One row of a staff member's day in the app's shape. An erased client (contract 1.8 §4.10) is
 * no client at all: the day column and the sheet then say «Walk-in χωρίς όνομα», like «Σήμερα»
 * and the conflicts, instead of an empty name.
 */
export function toDayAppointment(row: DayAppointmentRow): DayAppointment {
  return {
    id: row.id,
    staffId: row.staff_id,
    clientId: row.client_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bufferAfterMin: row.buffer_after_min,
    status: row.status,
    source: row.source,
    totalCents: row.total_cents,
    cancelReason: row.cancel_reason,
    client:
      row.client && row.client.erased_at === null
        ? { id: row.client.id, fullName: row.client.full_name, phoneE164: row.client.phone_e164 }
        : null,
    services: [...row.services]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        position: line.position,
        serviceId: line.service_id,
        durationMin: line.duration_min,
        priceCents: line.price_cents,
      })),
  }
}

export interface DayAppointment {
  readonly id: string
  readonly staffId: string
  readonly clientId: string | null
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly bufferAfterMin: number
  readonly status: AppointmentStatus
  readonly source: AppointmentSource
  readonly totalCents: number
  readonly cancelReason: CancelReason | null
  readonly client: {
    readonly id: string
    readonly fullName: string
    readonly phoneE164: string | null
  } | null
  readonly services: readonly {
    readonly position: number
    readonly serviceId: string
    readonly durationMin: number
    readonly priceCents: number
  }[]
}

// ---------------------------------------------------------------------------------------------
// today_summary
// ---------------------------------------------------------------------------------------------

const TodayItemResponse = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  status: AppointmentStatus,
  client_id: z.nullable(Id),
  client_name: z.nullable(z.string()),
  service_ids: z.array(Id),
})

export const TodaySummaryResponse = z.object({
  local_date: LocalDateString,
  timezone: z.string(),
  currency: CurrencyCode,
  scope: z.enum(['business', 'own']),
  counts: z.object({ total: Count, remaining: Count, to_mark: Count }),
  expected_revenue_cents: z.nullable(Cents),
  next: z.array(TodayItemResponse),
  gaps: z.array(z.object({ staff_id: Id, starts_at: Instant, ends_at: Instant, minutes: Minutes })),
  to_mark: z.array(TodayItemResponse),
})

export interface TodayItem {
  readonly appointmentId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly status: AppointmentStatus
  readonly clientId: string | null
  readonly clientName: string | null
  readonly serviceIds: readonly string[]
}

export interface TodayGap {
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly minutes: number
}

export interface TodaySummary {
  readonly localDate: LocalDate
  readonly timeZone: string
  readonly currency: string
  readonly scope: 'business' | 'own'
  readonly counts: { readonly total: number; readonly remaining: number; readonly toMark: number }
  /** null for anyone who is not owner/manager (decided in SQL). */
  readonly expectedRevenueCents: number | null
  readonly next: readonly TodayItem[]
  readonly gaps: readonly TodayGap[]
  readonly toMark: readonly TodayItem[]
}

// ---------------------------------------------------------------------------------------------
// staff_available_slots
// ---------------------------------------------------------------------------------------------

export const SlotRows = z.array(
  z.object({
    starts_at: Instant,
    local_date: LocalDateString,
    local_time: LocalTimeString,
    staff_ids: z.array(Id),
  }),
)

export interface Slot {
  readonly startsAt: Instant
  readonly localDate: LocalDate
  readonly localTime: LocalTime
  readonly staffIds: readonly string[]
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export interface StatusInput {
  readonly appointmentId: string
  readonly fromStatus: AppointmentStatus
  readonly status: StatusTarget
}

export const StatusResponse = z.object({
  appointment_id: Id,
  status: AppointmentStatus,
  from_status: AppointmentStatus,
  changed: z.boolean(),
})

export interface StatusResult {
  readonly appointmentId: string
  readonly status: AppointmentStatus
  readonly fromStatus: AppointmentStatus
  readonly changed: boolean
}

export interface CancelInput {
  readonly appointmentId: string
  readonly fromStatus: AppointmentStatus
  readonly reason: CancelReason
  readonly notify: boolean
}

export const CancelResponse = z.object({
  appointment_id: Id,
  status: z.literal('cancelled'),
  from_status: AppointmentStatus,
  changed: z.boolean(),
  cancelled_by: z.enum(CANCELLED_BY),
  cancel_reason: CancelReason,
  notify: z.boolean(),
  sms_queued: z.boolean(),
})

export interface CancelResult {
  readonly appointmentId: string
  readonly status: 'cancelled'
  readonly fromStatus: AppointmentStatus
  readonly changed: boolean
  readonly cancelledBy: (typeof CANCELLED_BY)[number]
  readonly cancelReason: CancelReason
  readonly notify: boolean
  readonly smsQueued: boolean
}

export interface MoveInput {
  readonly appointmentId: string
  readonly idempotencyKey: string
  readonly newStartsAt: Instant
  /** null = same staff member. */
  readonly newStaffId: string | null
  readonly notify: boolean
  readonly allowOutsideHours: boolean
  readonly allowBufferOverlap: boolean
}

export const MoveResponse = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  warnings: z.array(BookingWarning),
  from_staff_id: Id,
  from_starts_at: Instant,
  replayed: z.boolean(),
  notify: z.boolean(),
  sms_queued: z.boolean(),
})

export interface MoveResult {
  readonly appointmentId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly fromStaffId: string
  readonly fromStartsAt: Instant
  readonly warnings: readonly BookingWarning[]
  readonly replayed: boolean
  readonly notify: boolean
  readonly smsQueued: boolean
}

/**
 * The answer of `staff_move_appointment`, also given by `reassign_appointment` (0008, the absence
 * flow's hand-over at the same time).
 */
export function toMoveResult(data: unknown): MoveResult {
  const result = MoveResponse.parse(data)
  return {
    appointmentId: result.appointment_id,
    staffId: result.staff_id,
    startsAt: result.starts_at,
    endsAt: result.ends_at,
    fromStaffId: result.from_staff_id,
    fromStartsAt: result.from_starts_at,
    warnings: result.warnings,
    replayed: result.replayed,
    notify: result.notify,
    smsQueued: result.sms_queued,
  }
}

export type BookClientInput =
  | { readonly kind: 'existing'; readonly clientId: string }
  | {
      readonly kind: 'new'
      readonly fullName: string
      readonly phoneE164: string | null
      readonly locale: Locale
    }
  /** Only with source `walkin`: an anonymous walk-in. */
  | { readonly kind: 'none' }

export interface BookInput {
  readonly idempotencyKey: string
  readonly serviceIds: readonly [string]
  /**
   * Always a concrete staff member in the pro app (the UI preselects one); the contract's
   * «any staff» (`null`) is not offered in Phase 1.
   */
  readonly staffId: string
  readonly startsAt: Instant
  readonly source: 'phone' | 'walkin' | 'staff'
  readonly allowOutsideHours: boolean
  readonly allowBufferOverlap: boolean
  readonly client: BookClientInput
}

export const BookResponse = z.object({
  appointment_id: Id,
  staff_id: Id,
  starts_at: Instant,
  ends_at: Instant,
  total_cents: Cents,
  replayed: z.boolean(),
  warnings: z.array(BookingWarning),
})

export interface BookResult {
  readonly appointmentId: string
  readonly staffId: string
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly totalCents: number
  readonly replayed: boolean
  readonly warnings: readonly BookingWarning[]
}
