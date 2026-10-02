import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAttemptKey } from '@/features/appointments/attemptKey'
import { useCancelAction } from '@/features/appointments/hooks/useAppointmentActions'
import { canNotifyClient, smsNoteKey } from '@/features/appointments/rules'
import { useNow } from '@/features/calendar/hooks/useNow'
import type { RpcFailureInfo } from '@/shared/lib/rpcError'
import { invalidateResolved } from '../invalidate'
import type { ReassignInput, ScheduleConflict } from '../schema'
import { useReassignAction } from './useReassignAction'
import { useReassignCandidates } from './useScheduleConflicts'

/** On a reassignment these mean the colleague is no longer free (contract 1.6 §4.9). */
const COLLEAGUE_GONE: ReadonlySet<string> = new Set(['AN001', 'AN005', 'AN006', 'AN008'])
/** The appointment changed elsewhere (AN021: no longer where the row showed it). */
const LIST_STALE: ReadonlySet<string> = new Set(['AN020', 'AN021'])

export type ConflictOutcome =
  | { readonly kind: 'moved'; readonly staffId: string; readonly smsNote: SmsNote }
  | { readonly kind: 'cancelled'; readonly smsNote: SmsNote }
type SmsNote = ReturnType<typeof smsNoteKey>

/**
 * One conflict row's actions (contract 1.6 §4.9): reassignment to a free colleague at the same
 * time (`reassign_appointment`: only while the appointment is still where this row shows it, else
 * AN021; SMS off by default, D10) or cancellation (SMS on by default,
 * reason `staff_unavailable`, or `shop_closed` when the shop is closed). Both through the 1.4
 * hooks (no optimistic writes; the move keeps its idempotency key on retry; the cancel is
 * idempotent by content). The outcome exists only once the server answered.
 */
export function useConflictResolution({
  businessId,
  timeZone,
  conflict,
  onResolved,
}: {
  businessId: string
  timeZone: string
  conflict: ScheduleConflict
  onResolved?: (appointmentId: string) => void
}) {
  const queryClient = useQueryClient()
  const now = useNow()
  const keyFor = useAttemptKey()
  const [reassignNotify, setReassignNotify] = useState(false)
  const [cancelNotify, setCancelNotify] = useState(true)
  const [last, setLast] = useState<'move' | 'cancel' | null>(null)
  const [colleagueGone, setColleagueGone] = useState(false)
  const shopClosed = conflict.reasons.includes('shop_closed')
  const canNotify = canNotifyClient(
    {
      startsAt: conflict.startsAt,
      client: conflict.clientPhoneE164 ? { phoneE164: conflict.clientPhoneE164 } : null,
    },
    now,
  )
  const scope = { businessId, timeZone }
  const resolved = () => {
    void invalidateResolved(queryClient, businessId)
    onResolved?.(conflict.appointmentId)
  }
  // Both cases refetch the conflict rows AND the free colleagues: a changed row must come back
  // with its current staff member and time, or the same button would fail again.
  const onFailure = (failure: RpcFailureInfo, reassigning: boolean) => {
    if (failure.kind !== 'domain') return
    const notFree = reassigning && COLLEAGUE_GONE.has(failure.code)
    if (notFree) setColleagueGone(true)
    if (notFree || LIST_STALE.has(failure.code)) {
      void invalidateResolved(queryClient, businessId)
    }
  }
  const move = useReassignAction(scope, resolved, (failure) => onFailure(failure, true))
  const cancel = useCancelAction(scope, resolved, (failure) => onFailure(failure, false))
  const outcome: ConflictOutcome | null = move.result
    ? { kind: 'moved', staffId: move.result.staffId, smsNote: smsNoteKey(move.result) }
    : cancel.result
      ? { kind: 'cancelled', smsNote: smsNoteKey(cancel.result) }
      : null
  const candidates = useReassignCandidates(
    businessId,
    conflict.appointmentId,
    !shopClosed && outcome === null,
  )
  const busy = move.pending || move.locked || cancel.pending || cancel.locked

  return {
    outcome,
    candidates,
    shopClosed,
    canNotify,
    reassignNotify,
    setReassignNotify,
    cancelNotify,
    setCancelNotify,
    busy,
    colleagueGone,
    /** The staff member of the reassignment in flight (its button shows «Ανάθεση…»). */
    pendingStaffId: move.pending ? (move.variables?.newStaffId ?? null) : null,
    cancelling: cancel.pending,
    /**
     * The write whose failure is shown (the last one tried); none when the colleague is no
     * longer free, which `ReassignChoices` says in its own words.
     */
    failing: colleagueGone ? null : last === 'cancel' ? cancel : last === 'move' ? move : null,
    reassign: (staffId: string) => {
      setLast('move')
      setColleagueGone(false)
      cancel.reset()
      // The row as the owner saw it: the server hands it over only if it is still there.
      const payload: Omit<ReassignInput, 'idempotencyKey'> = {
        appointmentId: conflict.appointmentId,
        expectedStaffId: conflict.staffId,
        expectedStartsAt: conflict.startsAt,
        newStaffId: staffId,
        notify: canNotify && reassignNotify,
      }
      move.submit({ ...payload, idempotencyKey: keyFor(payload) })
    },
    cancel: () => {
      setLast('cancel')
      setColleagueGone(false)
      move.reset()
      cancel.submit({
        appointmentId: conflict.appointmentId,
        fromStatus: conflict.status,
        reason: shopClosed ? 'shop_closed' : 'staff_unavailable',
        notify: canNotify && cancelNotify,
        startsAt: conflict.startsAt,
      })
    },
    /** «Κλείσιμο» of an unknown outcome: stop, and let the lists show whether it went through. */
    giveUp: () => {
      move.refreshInvolved()
      cancel.refreshInvolved()
      move.reset()
      cancel.reset()
      setLast(null)
      void invalidateResolved(queryClient, businessId)
    },
  }
}

export type ConflictResolution = ReturnType<typeof useConflictResolution>
