import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import { BusinessRow, toBusiness, type Business } from './schema'

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
