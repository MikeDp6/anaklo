import { writeSignal } from '@/features/calendar/api'
import type { Database } from '@/shared/lib/database.types'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  StaffOrderResponse,
  StaffRow,
  StaffRows,
  toStaff,
  toStaffMember,
  toWeekHoursResult,
  toWeekRowArgs,
  toWeekRowList,
  WeekHoursResponse,
  WeekHoursRows,
  type StaffInput,
  type StaffMember,
  type StaffOrder,
  type WeekHoursResult,
  type WeekRow,
} from './schema'

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

const STAFF_COLUMNS = 'id, display_name, color, sort, active'

/** Active and inactive staff, in the business's order (contract 1.4 §3.1). */
export async function fetchStaff(businessId: string, signal?: AbortSignal): Promise<StaffMember[]> {
  let query = supabase
    .from('staff')
    .select(STAFF_COLUMNS)
    .eq('business_id', businessId)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toStaff(StaffRows.parse(data))
}

/**
 * A new staff member without a login (contract 1.6 §3.1): `INSERT … ON CONFLICT (id) DO NOTHING`
 * with the id fixed when the sheet opened, so the retry of an insert that committed inserts
 * nothing and still succeeds (`created: false`).
 */
export async function createStaff(
  businessId: string,
  input: StaffInput,
): Promise<{ readonly id: string; readonly created: boolean }> {
  const { data, error, status } = await supabase
    .from('staff')
    .upsert(
      {
        id: input.id,
        business_id: businessId,
        display_name: input.displayName,
        color: input.color,
        active: input.active,
        sort: input.sort,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id')
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return { id: input.id, created: (data ?? []).length > 0 }
}

/** Name, colour and active (the only columns the app may change; the order: `setStaffOrder`). */
export async function updateStaff(
  businessId: string,
  id: string,
  input: Pick<StaffInput, 'displayName' | 'color' | 'active'>,
): Promise<StaffMember> {
  const { data, error, status } = await supabase
    .from('staff')
    .update({ display_name: input.displayName, color: input.color, active: input.active })
    .eq('business_id', businessId)
    .eq('id', id)
    .select(STAFF_COLUMNS)
    .abortSignal(writeSignal())
    .single()
  throwIfFailed(error, status)
  return toStaffMember(StaffRow.parse(data))
}

/** The whole new order in one call (`set_staff_order`, §2.5.6). */
export async function setStaffOrder(
  businessId: string,
  staffIds: readonly string[],
): Promise<StaffOrder> {
  const args: Args<'set_staff_order'> = { p_business_id: businessId, p_staff_ids: [...staffIds] }
  const { data, error, status } = await supabase
    .rpc('set_staff_order', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return StaffOrderResponse.parse(data)
}

/** One staff member's weekly hours, by weekday and start. */
export async function fetchWeekHours(
  businessId: string,
  staffId: string,
  signal?: AbortSignal,
): Promise<WeekRow[]> {
  let query = supabase
    .from('working_hours')
    .select('weekday, start_time, end_time')
    .eq('business_id', businessId)
    .eq('staff_id', staffId)
    .order('weekday')
    .order('start_time')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toWeekRowList(WeekHoursRows.parse(data))
}

/** All the week at once (`replace_week_hours`, §2.5.1): overlaps → `23P01`, nothing changed. */
export async function replaceWeekHours(
  businessId: string,
  staffId: string,
  rows: readonly WeekRow[],
): Promise<WeekHoursResult> {
  const args: Args<'replace_week_hours'> = {
    p_business_id: businessId,
    p_staff_id: staffId,
    p_rows: toWeekRowArgs(rows),
  }
  const { data, error, status } = await supabase
    .rpc('replace_week_hours', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toWeekHoursResult(WeekHoursResponse.parse(data))
}
