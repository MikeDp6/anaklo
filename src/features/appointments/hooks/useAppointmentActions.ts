import {
  bookAppointment,
  cancelAppointment,
  moveAppointment,
  setAppointmentStatus,
} from '@/features/calendar/api'
import type {
  BookInput,
  BookResult,
  CancelInput,
  CancelResult,
  MoveInput,
  MoveResult,
  StatusInput,
  StatusResult,
} from '@/features/calendar/schema'
import type { RpcFailureInfo } from '@/shared/lib/rpcError'
import { useAppointmentMutation } from './useAppointmentMutation'

/** The start the appointment had when the sheet opened: its day is refreshed afterwards. */
interface Located {
  readonly startsAt: string
}

export type StatusVariables = StatusInput & Located
export type CancelVariables = CancelInput & Located
export type MoveVariables = MoveInput & { readonly fromStartsAt: string }

interface Scope {
  readonly businessId: string
  readonly timeZone: string
}

export function useStatusAction(
  { businessId, timeZone }: Scope,
  onSuccess?: (result: StatusResult) => void,
) {
  return useAppointmentMutation<StatusVariables, StatusResult>({
    businessId,
    timeZone,
    mutationFn: (variables) => setAppointmentStatus(businessId, variables),
    instantsOf: (variables) => [variables.startsAt],
    onSuccess,
  })
}

export function useCancelAction(
  { businessId, timeZone }: Scope,
  onSuccess?: (result: CancelResult) => void,
  onFailure?: (failure: RpcFailureInfo) => void,
) {
  return useAppointmentMutation<CancelVariables, CancelResult>({
    businessId,
    timeZone,
    mutationFn: (variables) => cancelAppointment(businessId, variables),
    instantsOf: (variables) => [variables.startsAt],
    onSuccess,
    onFailure,
  })
}

export function useMoveAction({ businessId, timeZone }: Scope) {
  return useAppointmentMutation<MoveVariables, MoveResult>({
    businessId,
    timeZone,
    mutationFn: (variables) => moveAppointment(businessId, variables),
    instantsOf: (variables, result) => [
      variables.fromStartsAt,
      variables.newStartsAt,
      ...(result ? [result.startsAt, result.fromStartsAt] : []),
    ],
  })
}

export function useBookAction({ businessId, timeZone }: Scope) {
  return useAppointmentMutation<BookInput, BookResult>({
    businessId,
    timeZone,
    mutationFn: (variables) => bookAppointment(businessId, variables),
    instantsOf: (variables, result) => [variables.startsAt, ...(result ? [result.startsAt] : [])],
  })
}
