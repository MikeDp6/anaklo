import type { Database } from '@/shared/lib/database.types'
import { localDateTimeToInstant, addLocalDays, type LocalDate } from '@/shared/lib/dates'
import type { SlotsQuery } from '@/shared/lib/proQueryKeys'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  BookResponse,
  CancelResponse,
  DayAppointmentRows,
  DayFrameResponse,
  SlotRows,
  StatusResponse,
  TodaySummaryResponse,
  type BookInput,
  type BookResult,
  type CancelInput,
  type CancelResult,
  type DayAppointment,
  type DayFrame,
  type MoveInput,
  type MoveResult,
  type Slot,
  type StatusInput,
  type StatusResult,
  type TodayItem,
  type TodaySummary,
  toMoveResult,
} from './schema'

/**
 * Data access of the day screens (contract 1.4 §3.1): the RPCs of 0006 and 0004, and the RLS read
 * of one staff member's day. Components never import supabase-js (rule 2); every answer is
 * parsed (zod/mini) and failures are thrown as `RpcFailure`.
 */

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

/** A write gives up after 15″: the outcome is then unknown and the sheet offers the retry. */
export const WRITE_TIMEOUT_MS = 15_000

export function writeSignal(): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(WRITE_TIMEOUT_MS)
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new DOMException('timed out', 'TimeoutError')),
    WRITE_TIMEOUT_MS,
  )
  return controller.signal
}

/** Appointments that still occupy the calendar (cancelled ones are not drawn). */
const DRAWN_STATUSES = ['booked', 'confirmed', 'completed', 'no_show'] as const

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The day's frame: working windows of every active staff member + colleagues' busy blocks. */
export async function fetchDayFrame(
  businessId: string,
  date: LocalDate,
  signal?: AbortSignal,
): Promise<DayFrame> {
  const args: Args<'busy_calendar'> = { p_business_id: businessId, p_local_date: date }
  let call = supabase.rpc('busy_calendar', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  const frame = DayFrameResponse.parse(data)
  return {
    localDate: frame.local_date,
    timeZone: frame.timezone,
    dayStart: frame.day_start,
    dayEnd: frame.day_end,
    windows: frame.windows.map((window) => ({
      staffId: window.staff_id,
      startsAt: window.starts_at,
      endsAt: window.ends_at,
    })),
    blocks: frame.blocks.map((block) => ({
      appointmentId: block.appointment_id,
      staffId: block.staff_id,
      startsAt: block.starts_at,
      endsAt: block.ends_at,
      bufferAfterMin: block.buffer_after_min,
    })),
  }
}

/** The instants of a local day `[00:00, next day 00:00)` in the business zone (23–25 hours). */
export function localDayBounds(date: LocalDate, timeZone: string): { from: string; to: string } {
  return {
    from: localDateTimeToInstant(date, '00:00', timeZone).toISOString(),
    to: localDateTimeToInstant(addLocalDays(date, 1), '00:00', timeZone).toISOString(),
  }
}

/** One staff member's appointments that overlap the day, with client and service lines (RLS). */
export async function fetchStaffDay(
  businessId: string,
  staffId: string,
  { from, to }: { from: string; to: string },
  signal?: AbortSignal,
): Promise<DayAppointment[]> {
  let query = supabase
    .from('appointments')
    .select(
      'id, staff_id, client_id, starts_at, ends_at, buffer_after_min, status, source, total_cents, cancel_reason, client:clients(id, full_name, phone_e164), services:appointment_services(position, service_id, duration_min, price_cents)',
    )
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    .in('status', [...DRAWN_STATUSES])
    .lt('starts_at', to)
    .gt('ends_at', from)
    .order('starts_at')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return DayAppointmentRows.parse(data).map((row) => ({
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
    client: row.client
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
  }))
}

function toTodayItem(item: {
  appointment_id: string
  staff_id: string
  starts_at: string
  ends_at: string
  status: TodayItem['status']
  client_id: string | null
  client_name: string | null
  service_ids: string[]
}): TodayItem {
  return {
    appointmentId: item.appointment_id,
    staffId: item.staff_id,
    startsAt: item.starts_at,
    endsAt: item.ends_at,
    status: item.status,
    clientId: item.client_id,
    clientName: item.client_name,
    serviceIds: item.service_ids,
  }
}

/** «Σήμερα»: next, gaps, to mark and (owner/manager only) the expected revenue. */
export async function fetchTodaySummary(
  businessId: string,
  signal?: AbortSignal,
): Promise<TodaySummary> {
  const args: Args<'today_summary'> = { p_business_id: businessId }
  let call = supabase.rpc('today_summary', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  const summary = TodaySummaryResponse.parse(data)
  return {
    localDate: summary.local_date,
    timeZone: summary.timezone,
    currency: summary.currency,
    scope: summary.scope,
    counts: {
      total: summary.counts.total,
      remaining: summary.counts.remaining,
      toMark: summary.counts.to_mark,
    },
    expectedRevenueCents: summary.expected_revenue_cents,
    next: summary.next.map(toTodayItem),
    gaps: summary.gaps.map((gap) => ({
      staffId: gap.staff_id,
      startsAt: gap.starts_at,
      endsAt: gap.ends_at,
      minutes: gap.minutes,
    })),
    toMark: summary.to_mark.map(toTodayItem),
  }
}

/** Free starts for staff (no online limits): quick add and move share it. */
export async function fetchStaffSlots(
  businessId: string,
  query: SlotsQuery & { readonly staffId: string },
  signal?: AbortSignal,
): Promise<Slot[]> {
  const args: Args<'staff_available_slots'> = {
    p_business_id: businessId,
    p_service_ids: [...query.serviceIds],
    p_staff_id: query.staffId,
    p_from: query.from,
    p_to: query.to,
    ...(query.excludeAppointmentId ? { p_exclude_appointment_id: query.excludeAppointmentId } : {}),
  }
  let call = supabase.rpc('staff_available_slots', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return SlotRows.parse(data).map((slot) => ({
    startsAt: slot.starts_at,
    localDate: slot.local_date,
    localTime: slot.local_time.slice(0, 5),
    staffIds: slot.staff_ids,
  }))
}

// ---------------------------------------------------------------------------------------------
// Writes: never retried automatically; a retry after `offline` resends the same variables.
// ---------------------------------------------------------------------------------------------

export async function setAppointmentStatus(
  businessId: string,
  input: StatusInput,
): Promise<StatusResult> {
  const args: Args<'set_appointment_status'> = {
    p_business_id: businessId,
    p_appointment_id: input.appointmentId,
    p_from_status: input.fromStatus,
    p_status: input.status,
  }
  const { data, error, status } = await supabase
    .rpc('set_appointment_status', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  const result = StatusResponse.parse(data)
  return {
    appointmentId: result.appointment_id,
    status: result.status,
    fromStatus: result.from_status,
    changed: result.changed,
  }
}

export async function cancelAppointment(
  businessId: string,
  input: CancelInput,
): Promise<CancelResult> {
  const args: Args<'cancel_appointment'> = {
    p_business_id: businessId,
    p_appointment_id: input.appointmentId,
    p_from_status: input.fromStatus,
    p_reason: input.reason,
    p_notify: input.notify,
  }
  const { data, error, status } = await supabase
    .rpc('cancel_appointment', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  const result = CancelResponse.parse(data)
  return {
    appointmentId: result.appointment_id,
    status: result.status,
    fromStatus: result.from_status,
    changed: result.changed,
    cancelledBy: result.cancelled_by,
    cancelReason: result.cancel_reason,
    notify: result.notify,
    smsQueued: result.sms_queued,
  }
}

export async function moveAppointment(businessId: string, input: MoveInput): Promise<MoveResult> {
  const args: Args<'staff_move_appointment'> = {
    p_business_id: businessId,
    p_appointment_id: input.appointmentId,
    p_idempotency_key: input.idempotencyKey,
    p_new_starts_at: input.newStartsAt,
    p_notify: input.notify,
    ...(input.newStaffId ? { p_new_staff_id: input.newStaffId } : {}),
    p_allow_outside_hours: input.allowOutsideHours,
    p_allow_buffer_overlap: input.allowBufferOverlap,
  }
  const { data, error, status } = await supabase
    .rpc('staff_move_appointment', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toMoveResult(data)
}

/** Phone booking, staff booking or walk-in, with a new client inline: one round trip (0004). */
export async function bookAppointment(businessId: string, input: BookInput): Promise<BookResult> {
  const { client } = input
  const args: Args<'staff_book_appointment'> = {
    p_business_id: businessId,
    p_service_ids: [...input.serviceIds],
    p_staff_id: input.staffId,
    p_starts_at: input.startsAt,
    p_source: input.source,
    p_idempotency_key: input.idempotencyKey,
    p_allow_outside_hours: input.allowOutsideHours,
    p_allow_buffer_overlap: input.allowBufferOverlap,
    ...(client.kind === 'existing' ? { p_client_id: client.clientId } : {}),
    ...(client.kind === 'new'
      ? {
          p_new_client: {
            full_name: client.fullName,
            phone_e164: client.phoneE164,
            locale: client.locale,
          },
        }
      : {}),
  }
  const { data, error, status } = await supabase
    .rpc('staff_book_appointment', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  const result = BookResponse.parse(data)
  return {
    appointmentId: result.appointment_id,
    staffId: result.staff_id,
    startsAt: result.starts_at,
    endsAt: result.ends_at,
    totalCents: result.total_cents,
    replayed: result.replayed,
    warnings: result.warnings,
  }
}
