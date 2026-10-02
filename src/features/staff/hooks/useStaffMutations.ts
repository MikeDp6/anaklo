import { invalidateScheduleChange } from '@/features/calendar/invalidate'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { createStaff, setStaffOrder, updateStaff } from '../api'
import type { StaffInput, StaffMember, StaffOrder } from '../schema'
import { applyOrder } from '../staffOrder'

/**
 * Staff writes (contract 1.6 §3.4). Day frames list the active staff and a deactivation creates
 * conflicts, so a create or update refreshes the schedule too; a reorder only the lists.
 */
export function useCreateStaff(businessId: string) {
  return useSettingsMutation<StaffInput, { readonly id: string; readonly created: boolean }>({
    mutationFn: (input) => createStaff(businessId, input),
    invalidate: async (queryClient) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.staff(businessId) }),
        invalidateScheduleChange(queryClient, businessId),
      ])
    },
  })
}

export function useUpdateStaff(businessId: string) {
  return useSettingsMutation<StaffInput, StaffMember>({
    mutationFn: (input) => updateStaff(businessId, input.id, input),
    invalidate: async (queryClient) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.staff(businessId) }),
        invalidateScheduleChange(queryClient, businessId),
      ])
    },
  })
}

/**
 * `set_staff_order`: the list shows the new order only from the server's answer (written into the
 * cache after it, never before), then refetches.
 */
export function useSetStaffOrder(businessId: string) {
  return useSettingsMutation<readonly string[], StaffOrder>({
    mutationFn: (ids) => setStaffOrder(businessId, ids),
    invalidate: async (queryClient, _ids, order) => {
      if (order) {
        queryClient.setQueryData<StaffMember[]>(proKeys.staff(businessId), (staff) =>
          staff ? applyOrder(staff, order) : staff,
        )
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: proKeys.staff(businessId) }),
        queryClient.invalidateQueries({ queryKey: proKeys.dayAll(businessId) }),
      ])
    },
  })
}
