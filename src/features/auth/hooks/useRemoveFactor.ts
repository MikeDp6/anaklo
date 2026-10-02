import { useQueryClient } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { removeFactor } from '../mfaApi'
import { useStepUp } from './useStepUp'

/**
 * «Αφαίρεση» of a device (contract 1.7 §6.7): through `manage-factors`, which asks the server for
 * a fresh code first (the code sheet, then one retry). «Η συσκευή αφαιρέθηκε.» only after the
 * answer (rule 14); any failure reloads the list, so it shows what the server has.
 */
export function useRemoveFactor(userId: string) {
  const queryClient = useQueryClient()
  const stepUp = useStepUp()
  const refresh = () => queryClient.invalidateQueries({ queryKey: proKeys.mfaFactors(userId) })
  return useSettingsMutation<string, void>({
    mutationFn: async (factorId) => {
      try {
        await stepUp(() => removeFactor(factorId))
      } catch (error) {
        void refresh()
        throw error
      }
    },
    invalidate: refresh,
  })
}
