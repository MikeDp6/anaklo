import type { QueryClient } from '@tanstack/react-query'
import { useStepUp } from '@/features/auth/hooks/useStepUp'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { inviteMember, removeMember, setMemberRole } from '../api'
import type { InviteBody, InviteResult, RemoveResult, RoleChange, SetRoleResult } from '../schema'

/**
 * The member writes (contract 1.7 §6.8). Each one is a critical action: the server asks for a
 * fresh code (42501 + hint) and `useStepUp` opens the code sheet then, never before (D18), and
 * repeats the call once. Success shows only from the server's answer (rule 14).
 */

/** A member change touches the list and the staff rows' links (contract 1.7 §6.10). */
async function invalidateMembers(queryClient: QueryClient, businessId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: proKeys.members(businessId) }),
    queryClient.invalidateQueries({ queryKey: proKeys.staff(businessId) }),
  ])
}

export function useInviteMember(businessId: string) {
  const stepUp = useStepUp()
  return useSettingsMutation<InviteBody, InviteResult>({
    mutationFn: (body) => stepUp(() => inviteMember(body)),
    invalidate: (queryClient) => invalidateMembers(queryClient, businessId),
  })
}

export function useSetMemberRole(businessId: string) {
  const stepUp = useStepUp()
  return useSettingsMutation<RoleChange, SetRoleResult>({
    mutationFn: (change) => stepUp(() => setMemberRole(businessId, change)),
    invalidate: (queryClient) => invalidateMembers(queryClient, businessId),
  })
}

export function useRemoveMember(businessId: string) {
  const stepUp = useStepUp()
  return useSettingsMutation<string, RemoveResult>({
    mutationFn: (userId) => stepUp(() => removeMember(businessId, userId)),
    invalidate: (queryClient) => invalidateMembers(queryClient, businessId),
  })
}
