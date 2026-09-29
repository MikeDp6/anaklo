import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import { StaffRows, toStaff, type StaffMember } from './schema'

/** Active and inactive staff, in the business's order (contract 1.4 §3.1). */
export async function fetchStaff(businessId: string, signal?: AbortSignal): Promise<StaffMember[]> {
  let query = supabase
    .from('staff')
    .select('id, display_name, color, sort, active')
    .eq('business_id', businessId)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toStaff(StaffRows.parse(data))
}
