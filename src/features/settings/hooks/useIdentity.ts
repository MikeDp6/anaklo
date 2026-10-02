import { useQuery } from '@tanstack/react-query'
import { useRevalidator } from 'react-router'
import { useStepUp } from '@/features/auth/hooks/useStepUp'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { changeBusinessIdentity, fetchIdentity } from '../api'
import type { IdentityChange, IdentityResult } from '../schema'

/** Slug, zone, currency and former slugs (contract 1.7 §6.10: 60″ fresh, refetch on focus). */
export function useIdentity(businessId: string) {
  return useQuery({
    queryKey: proKeys.identity(businessId),
    queryFn: ({ signal }) => fetchIdentity(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * `change_business_identity`, a critical action: the server asks for a fresh code (42501 + hint)
 * and `useStepUp` opens the code sheet then, never before (D18), and repeats the call once. Zone
 * and currency shape every screen: everything of the business is refetched and the member route
 * revalidates (contract 1.7 §6.10).
 */
export function useChangeIdentity(
  businessId: string,
  onSuccess?: (result: IdentityResult) => void,
) {
  const stepUp = useStepUp()
  const revalidator = useRevalidator()
  return useSettingsMutation<IdentityChange, IdentityResult>({
    mutationFn: (change) => stepUp(() => changeBusinessIdentity(businessId, change)),
    invalidate: async (queryClient) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.all(businessId) }),
        revalidator.revalidate(),
      ])
    },
    onSuccess,
  })
}
