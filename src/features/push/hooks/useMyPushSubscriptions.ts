import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { fetchMyPushSubscriptions } from '../api'

/**
 * The signed-in user's own `push_subscriptions` rows (RLS), fresh on every visit and focus: a row
 * can move to another user on a shared phone, or go with a membership change, at any time.
 */
export function useMyPushSubscriptions(userId: string, enabled: boolean) {
  return useQuery({
    queryKey: proKeys.pushSubscriptions(userId),
    queryFn: ({ signal }) => fetchMyPushSubscriptions(signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
}
