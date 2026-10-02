import { WRITE_TIMEOUT_MS } from '@/features/calendar/api'
import { toMoveResult, type MoveResult } from '@/features/calendar/schema'
import type { Database } from '@/shared/lib/database.types'
import type { LocalDate } from '@/shared/lib/dates'
import { RpcFailure, throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  AbsenceResponse,
  AliasRows,
  BookingPolicyRow,
  BusinessRow,
  ConflictRows,
  ExceptionRows,
  IdentityResponse,
  IdentityRow,
  POLICY_COLUMNS,
  ReassignRows,
  TimeOffRows,
  toAbsenceResult,
  toBookingPolicy,
  toBusiness,
  toCandidates,
  toConflicts,
  toExceptions,
  toIdentity,
  toIdentityResult,
  toTimeOff,
  type AbsenceInput,
  type AbsenceResult,
  type BookingPolicy,
  type BookingPolicyInput,
  type Business,
  type BusinessIdentity,
  type ConflictsQuery,
  type IdentityChange,
  type IdentityResult,
  type NewException,
  type ReassignCandidate,
  type ReassignInput,
  type ScheduleConflict,
  type ScheduleException,
  type TimeOff,
  type TimeOffInput,
} from './schema'

/**
 * Data access of the settings screens (contract 1.6 §3.1). Components never import supabase-js
 * (rule 2). Every answer is parsed (zod/mini); failures are thrown as `RpcFailure`. Writes give up
 * after 15″ (the outcome is then unknown and the form offers the identical retry); new rows carry
 * a client-generated id and are inserted with `ON CONFLICT (id) DO NOTHING`, so the retry of a
 * write that did commit inserts nothing and still succeeds (contract 1.6 D17).
 */

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

function writeSignal(): AbortSignal {
  return AbortSignal.timeout(WRITE_TIMEOUT_MS)
}

/** Most rows a settings list reads (closures, time off): far more than a shop ever plans. */
const LIST_LIMIT = 500

/** The business of the signed-in member (RLS: members read their own businesses). */
export async function fetchBusiness(businessId: string, signal?: AbortSignal): Promise<Business> {
  let query = supabase
    .from('businesses')
    .select('id, name, timezone, currency, locale, slot_step_min, correction_window_days')
    .eq('id', businessId)
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query.single()
  throwIfFailed(error, status)
  return toBusiness(BusinessRow.parse(data))
}

// ---------------------------------------------------------------------------------------------
// Booking policy
// ---------------------------------------------------------------------------------------------

export async function fetchBookingPolicy(
  businessId: string,
  signal?: AbortSignal,
): Promise<BookingPolicy> {
  let query = supabase.from('businesses').select(POLICY_COLUMNS).eq('id', businessId)
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query.single()
  throwIfFailed(error, status)
  return toBookingPolicy(BookingPolicyRow.parse(data))
}

/** Writes every policy column (column UPDATE grants) and returns what the server stored. */
export async function updateBookingPolicy(
  businessId: string,
  input: BookingPolicyInput,
): Promise<BookingPolicy> {
  const { data, error, status } = await supabase
    .from('businesses')
    .update({
      booking_enabled: input.bookingEnabled,
      slot_step_min: input.slotStepMin,
      min_notice_min: input.minNoticeMin,
      max_advance_days: input.maxAdvanceDays,
      cancel_min_notice_min: input.cancelMinNoticeMin,
      auto_complete_after_min: input.autoCompleteAfterMin,
      correction_window_days: input.correctionWindowDays,
      allow_any_staff: input.allowAnyStaff,
      messaging_enabled: input.messagingEnabled,
      quiet_start: input.quietStart,
      quiet_end: input.quietEnd,
      reminder_mode: input.reminderMode,
    })
    .eq('id', businessId)
    .select(POLICY_COLUMNS)
    .abortSignal(writeSignal())
    .single()
  throwIfFailed(error, status)
  return toBookingPolicy(BookingPolicyRow.parse(data))
}

// ---------------------------------------------------------------------------------------------
// Closures and special hours (schedule_exceptions)
// ---------------------------------------------------------------------------------------------

/** Exceptions from `fromDate` (business-local) on, by date and start. */
export async function fetchExceptions(
  businessId: string,
  fromDate: LocalDate,
  signal?: AbortSignal,
): Promise<ScheduleException[]> {
  let query = supabase
    .from('schedule_exceptions')
    .select('id, staff_id, local_date, kind, start_time, end_time, note')
    .eq('business_id', businessId)
    .gte('local_date', fromDate)
    .order('local_date')
    .order('start_time', { nullsFirst: true })
    .order('id')
    .limit(LIST_LIMIT)
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toExceptions(ExceptionRows.parse(data))
}

/** One bulk insert (all or nothing); rows whose id exists already are skipped (a retry). */
export async function addExceptions(
  businessId: string,
  rows: readonly NewException[],
): Promise<void> {
  const { error, status } = await supabase
    .from('schedule_exceptions')
    .upsert(
      rows.map((row) => ({
        id: row.id,
        business_id: businessId,
        staff_id: row.staffId,
        local_date: row.localDate,
        kind: row.kind,
        start_time: row.startTime,
        end_time: row.endTime,
        note: row.note,
      })),
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
}

/**
 * Ids per DELETE request. PostgREST takes the `in` filter in the URL, and a grouped item can hold
 * hundreds of rows (62 dates × 4 intervals, more when adjacent saves merge): from about 240 uuids
 * the gateway answers 414 (URI too long). 100 uuids are about 3.7 KB of query string.
 */
export const DELETE_CHUNK = 100

/**
 * Deletes every id of a grouped item, in requests of at most `DELETE_CHUNK` ids sent one after
 * another. Deleting again deletes nothing, so the identical retry after an unknown outcome (some
 * requests may have gone through) finishes the job.
 */
export async function deleteExceptions(businessId: string, ids: readonly string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += DELETE_CHUNK) {
    const { error, status } = await supabase
      .from('schedule_exceptions')
      .delete()
      .eq('business_id', businessId)
      .in('id', ids.slice(start, start + DELETE_CHUNK))
      .abortSignal(writeSignal())
    throwIfFailed(error, status)
  }
}

// ---------------------------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------------------------

/** Current and future time off (`ends_at > now`), by start. */
export async function fetchTimeOff(
  businessId: string,
  now: Date,
  signal?: AbortSignal,
): Promise<TimeOff[]> {
  let query = supabase
    .from('time_off')
    .select('id, staff_id, starts_at, ends_at, reason')
    .eq('business_id', businessId)
    .gt('ends_at', now.toISOString())
    .order('starts_at')
    .order('id')
    .limit(LIST_LIMIT)
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toTimeOff(TimeOffRows.parse(data))
}

/**
 * New: insert with the form's id (skipped if it exists). Existing: update of range and reason only
 * (a time off is never moved to another staff member: the row must still be that staff member's),
 * asking for the row back: no row means it was deleted meanwhile (another device, or merged by
 * `mark_absence`), which is `gone`, never a success. The retry of an update that did commit still
 * finds its row.
 */
export async function saveTimeOff(businessId: string, input: TimeOffInput): Promise<void> {
  if (input.isNew) {
    const { error, status } = await supabase
      .from('time_off')
      .upsert(
        {
          id: input.id,
          business_id: businessId,
          staff_id: input.staffId,
          starts_at: input.startsAt,
          ends_at: input.endsAt,
          reason: input.reason,
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      .abortSignal(writeSignal())
    throwIfFailed(error, status)
    return
  }
  const { data, error, status } = await supabase
    .from('time_off')
    .update({ starts_at: input.startsAt, ends_at: input.endsAt, reason: input.reason })
    .eq('business_id', businessId)
    .eq('id', input.id)
    .eq('staff_id', input.staffId)
    .select('id')
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  if (!data || data.length === 0) throw new RpcFailure({ kind: 'gone' })
}

export async function deleteTimeOff(businessId: string, id: string): Promise<void> {
  const { error, status } = await supabase
    .from('time_off')
    .delete()
    .eq('business_id', businessId)
    .eq('id', id)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
}

// ---------------------------------------------------------------------------------------------
// Conflicts, absence, reassignment (0008 RPCs, owner/manager)
// ---------------------------------------------------------------------------------------------

export async function fetchScheduleConflicts(
  businessId: string,
  query: ConflictsQuery,
  signal?: AbortSignal,
): Promise<ScheduleConflict[]> {
  const args: Args<'schedule_conflicts'> = {
    p_business_id: businessId,
    ...(query.staffId ? { p_staff_id: query.staffId } : {}),
    ...(query.from ? { p_from: query.from } : {}),
    ...(query.to ? { p_to: query.to } : {}),
  }
  let call = supabase.rpc('schedule_conflicts', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return toConflicts(ConflictRows.parse(data))
}

/** Writes (or keeps, or extends) a `leave` time off; idempotent by content. */
export async function markAbsence(businessId: string, input: AbsenceInput): Promise<AbsenceResult> {
  const args: Args<'mark_absence'> = {
    p_business_id: businessId,
    p_staff_id: input.staffId,
    p_from: input.from,
    p_to: input.to,
  }
  const { data, error, status } = await supabase
    .rpc('mark_absence', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toAbsenceResult(AbsenceResponse.parse(data))
}

/** Which active colleagues could take the appointment at the same time (contract 1.6 §2.5.4). */
export async function fetchReassignCandidates(
  businessId: string,
  appointmentId: string,
  signal?: AbortSignal,
): Promise<ReassignCandidate[]> {
  const args: Args<'reassign_candidates'> = {
    p_business_id: businessId,
    p_appointment_id: appointmentId,
  }
  let call = supabase.rpc('reassign_candidates', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return toCandidates(ReassignRows.parse(data))
}

/**
 * Hands the appointment to a colleague at the same time, only while it is where the conflict row
 * showed it (else AN021; contract 1.6 «Review fixes»). The answer is `staff_move_appointment`'s.
 */
export async function reassignAppointment(
  businessId: string,
  input: ReassignInput,
): Promise<MoveResult> {
  const args: Args<'reassign_appointment'> = {
    p_business_id: businessId,
    p_appointment_id: input.appointmentId,
    p_idempotency_key: input.idempotencyKey,
    p_expected_staff_id: input.expectedStaffId,
    p_expected_starts_at: input.expectedStartsAt,
    p_new_staff_id: input.newStaffId,
    p_notify: input.notify,
  }
  const { data, error, status } = await supabase
    .rpc('reassign_appointment', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toMoveResult(data)
}

// ---------------------------------------------------------------------------------------------
// Business identity (0009, owner only; contract 1.7 §6.9)
// ---------------------------------------------------------------------------------------------

/** Slug, zone and currency of the business, and its former slugs (newest first). */
export async function fetchIdentity(
  businessId: string,
  signal?: AbortSignal,
): Promise<BusinessIdentity> {
  let business = supabase
    .from('businesses')
    .select('id, slug, timezone, currency')
    .eq('id', businessId)
  let aliases = supabase
    .from('business_slug_aliases')
    .select('slug')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .order('slug')
    .limit(LIST_LIMIT)
  if (signal) {
    business = business.abortSignal(signal)
    aliases = aliases.abortSignal(signal)
  }
  const [row, former] = await Promise.all([business.single(), aliases])
  throwIfFailed(row.error, row.status)
  throwIfFailed(former.error, former.status)
  return toIdentity(IdentityRow.parse(row.data), AliasRows.parse(former.data))
}

/**
 * `change_business_identity` (owner + fresh code, checked in its `_impl`): only the changed
 * fields are sent, the others stay the RPC's default `null` = unchanged. Refusals: AN024 (slug
 * taken, reserved or a former slug of another business), AN025 (zone or currency while future
 * appointments exist). The UI never counts those appointments itself (rule 13).
 */
export async function changeBusinessIdentity(
  businessId: string,
  change: IdentityChange,
): Promise<IdentityResult> {
  const args: Args<'change_business_identity'> = {
    p_business_id: businessId,
    ...(change.slug !== undefined ? { p_slug: change.slug } : {}),
    ...(change.timeZone !== undefined ? { p_timezone: change.timeZone } : {}),
    ...(change.currency !== undefined ? { p_currency: change.currency } : {}),
  }
  const { data, error, status } = await supabase
    .rpc('change_business_identity', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toIdentityResult(IdentityResponse.parse(data))
}
