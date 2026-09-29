import type { Database } from '@/shared/lib/database.types'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import { ClientHitRows, type ClientHit } from './schema'

type Args = Database['public']['Functions']['search_clients']['Args']

/**
 * Client search of the quick add (reused by the client card in 1.8): name in Greek, Greeklish or
 * capitals, or the last digits of the phone (contract 1.4 §2.6.7).
 */
export async function searchClients(
  businessId: string,
  query: string,
  signal?: AbortSignal,
): Promise<ClientHit[]> {
  const args: Args = { p_business_id: businessId, p_query: query }
  let call = supabase.rpc('search_clients', args)
  if (signal) call = call.abortSignal(signal)
  const { data, error, status } = await call
  throwIfFailed(error, status)
  return ClientHitRows.parse(data).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    phoneE164: row.phone_e164,
    lastVisitAt: row.last_visit_at,
  }))
}
