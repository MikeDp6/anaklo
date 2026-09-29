import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import { ServiceRows, toServices, type Service } from './schema'

/** Active services with who offers them (contract 1.4 §3.1). */
export async function fetchServices(businessId: string, signal?: AbortSignal): Promise<Service[]> {
  let query = supabase
    .from('services')
    .select(
      'id, name, duration_min, buffer_after_min, price_cents, sort, staff_services(staff_id, custom_duration_min, custom_price_cents)',
    )
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toServices(ServiceRows.parse(data))
}
