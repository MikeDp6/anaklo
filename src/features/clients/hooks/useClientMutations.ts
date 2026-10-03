import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useStepUp } from '@/features/auth/hooks/useStepUp'
import { failureOf } from '@/shared/lib/rpcError'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import {
  addClientNote,
  deleteClientNote,
  eraseClient,
  setClientConsent,
  updateClientDetails,
} from '../api'
import { forgetErasedClients, invalidateClientCard, invalidateClientIdentity } from '../invalidate'
import type {
  ConsentInput,
  DetailsInput,
  EraseResult,
  NoteInput,
  SetConsentResult,
} from '../schema'

/**
 * The writes of the client card (contract 1.8 §3.4–§3.5), with the semantics of the settings
 * writes (`useSettingsMutation`, rule 14): nothing is shown as done before the server answered,
 * an unknown outcome locks the form and offers the identical retry (each write here is
 * idempotent), and what the write touches refetches after the answer.
 */

/** Where the search list lands after an erase: it shows «Ο πελάτης ανωνυμοποιήθηκε.». */
export const ERASED_NOTICE = 'erased'

/**
 * AN033 (the client was merged or erased meanwhile): the card refetches, so it redirects to the
 * merged client or shows the erased view; the form shows the reason.
 */
function refreshOnUnavailable<V, R>(
  queryClient: QueryClient,
  businessId: string,
  clientId: string,
  call: (variables: V) => Promise<R>,
): (variables: V) => Promise<R> {
  return async (variables) => {
    try {
      return await call(variables)
    } catch (error) {
      const failure = failureOf(error)
      if (failure.kind === 'domain' && failure.code === 'AN033') {
        void invalidateClientCard(queryClient, businessId, clientId)
      }
      throw error
    }
  }
}

export function useAddNote(businessId: string, clientId: string, onSaved?: () => void) {
  const queryClient = useQueryClient()
  return useSettingsMutation<NoteInput, void>({
    mutationFn: refreshOnUnavailable(queryClient, businessId, clientId, (input: NoteInput) =>
      addClientNote(businessId, input),
    ),
    invalidate: (client) => invalidateClientCard(client, businessId, clientId),
    onSuccess: onSaved,
  })
}

export function useDeleteNote(businessId: string, clientId: string) {
  return useSettingsMutation<string, number>({
    mutationFn: (noteId) => deleteClientNote(businessId, noteId),
    invalidate: (client) => invalidateClientCard(client, businessId, clientId),
  })
}

export function useSetConsent(businessId: string, clientId: string, onDone?: () => void) {
  const queryClient = useQueryClient()
  return useSettingsMutation<ConsentInput, SetConsentResult>({
    mutationFn: refreshOnUnavailable(queryClient, businessId, clientId, (input: ConsentInput) =>
      setClientConsent(businessId, input),
    ),
    invalidate: (client) => invalidateClientCard(client, businessId, clientId),
    onSuccess: onDone,
  })
}

/** Name, mobile and language show on the day, «Σήμερα», the conflicts and the search too. */
export function useUpdateDetails(businessId: string, clientId: string) {
  const queryClient = useQueryClient()
  return useSettingsMutation<DetailsInput, void>({
    mutationFn: refreshOnUnavailable(queryClient, businessId, clientId, (input: DetailsInput) =>
      updateClientDetails(businessId, clientId, input),
    ),
    invalidate: (client) => invalidateClientIdentity(client, businessId),
  })
}

/**
 * Anonymisation (contract 1.8 §4.8): a critical action, so the call goes through `useStepUp`
 * (the server asks for a fresh code; the sheet opens only then, and the call runs once more).
 * Success only after the answer (`erased: false`, a committed retry, included): the erased
 * family's cards and every cached list not on screen leave the cache (the name is never shown
 * again from it), a card on screen is reset (it loads the erased view, never keeps the old card),
 * the lists on screen refetch, and the app returns to the search with a notice. The dialog cannot
 * be closed while the call runs, so the notice is never lost.
 */
export function useEraseClient(businessId: string) {
  const stepUp = useStepUp()
  const navigate = useNavigate()
  return useSettingsMutation<string, EraseResult>({
    mutationFn: (clientId) => stepUp(() => eraseClient(businessId, clientId)),
    invalidate: (queryClient, clientId, result) =>
      result
        ? forgetErasedClients(queryClient, businessId, [
            clientId,
            result.clientId,
            ...result.erasedIds,
          ])
        : invalidateClientIdentity(queryClient, businessId),
    onSuccess: () => {
      void navigate('/clients', { replace: true, state: { notice: ERASED_NOTICE } })
    },
  })
}
