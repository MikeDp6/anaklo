import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { failureOf } from '@/shared/lib/rpcError'
import { fetchClientCard } from '../api'

/**
 * The client card (contract 1.8 §3.3): 30″ fresh, refetched on focus and on reconnect, no
 * interval (Phase 1 has no Realtime). `clientId` null (not a uuid) = no request at all. A
 * refusal (`forbidden`: an unknown id or another business's client) is final: not retried.
 */
export function useClientCard(businessId: string, clientId: string | null) {
  return useQuery({
    queryKey: proKeys.clientCard(businessId, clientId ?? ''),
    queryFn: ({ signal }) => fetchClientCard(businessId, clientId ?? '', signal),
    enabled: clientId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (count, error) => count < 1 && failureOf(error).kind !== 'forbidden',
  })
}
