import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { listVerifiedFactors } from '../mfaApi'

/** The user's verified authenticator devices (contract 1.7 §6.10): 60″ fresh, again on focus. */
export function useMfaFactors(userId: string, enabled = true) {
  return useQuery({
    queryKey: proKeys.mfaFactors(userId),
    queryFn: listVerifiedFactors,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    enabled,
  })
}
