import { useAppointmentMutation } from '@/features/appointments/hooks/useAppointmentMutation'
import type { MoveResult } from '@/features/calendar/schema'
import type { RpcFailureInfo } from '@/shared/lib/rpcError'
import { reassignAppointment } from '../api'
import type { ReassignInput } from '../schema'

/**
 * «Ανάθεση: …» of a conflict row (contract 1.6 §4.9 and «Review fixes»): `reassign_appointment`,
 * which hands the appointment over at the same time only while it is still where the row showed
 * it (AN021 otherwise, so a stale row never moves it back). Same semantics as the 1.4 move: no
 * optimistic write, the identical retry keeps the key, the day(s) involved are refreshed after the
 * answer (and after AN001/AN020/AN021). `onSuccess`/`onFailure`: per call, while mounted.
 */
export function useReassignAction(
  { businessId, timeZone }: { readonly businessId: string; readonly timeZone: string },
  onSuccess?: (result: MoveResult) => void,
  onFailure?: (failure: RpcFailureInfo) => void,
) {
  return useAppointmentMutation<ReassignInput, MoveResult>({
    businessId,
    timeZone,
    mutationFn: (variables) => reassignAppointment(businessId, variables),
    instantsOf: (variables, result) => [
      variables.expectedStartsAt,
      ...(result ? [result.startsAt, result.fromStartsAt] : []),
    ],
    onSuccess,
    onFailure,
  })
}
