import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStaffDay } from '@/features/calendar/hooks/useDayQueries'
import { useNow } from '@/features/calendar/hooks/useNow'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { invalidateAppointmentChange } from '@/features/calendar/invalidate'
import type { DayAppointment } from '@/features/calendar/schema'
import type { LocalDate } from '@/shared/lib/dates'
import { failureOf, rpcFailureMessageKey } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useCancelAction, useStatusAction } from '../hooks/useAppointmentActions'
import { canMove } from '../rules'
import { AppointmentDetails } from './AppointmentDetails'
import { CancelForm } from './CancelForm'
import styles from './forms.module.css'
import { MoveFlow } from './MoveFlow'
import { SaveFailure } from './SaveFailure'
import { Sheet } from './Sheet'
import { StatusActions } from './StatusActions'

/** Which appointment: the sheet reads it from its column's day query (the shared cache). */
export interface AppointmentTarget {
  readonly appointmentId: string
  readonly staffId: string
  readonly localDate: LocalDate
}

type Mode = { kind: 'details' } | { kind: 'cancel' | 'move'; appointment: DayAppointment }

/**
 * One appointment: details, confirm / «Ήρθε» / «Δεν ήρθε» (and corrections), cancel with a reason,
 * move. Every change waits for the server (rule 14); the lists refresh through `invalidate.ts`.
 */
export function AppointmentSheet({
  workspace,
  target,
  today,
  onClose,
}: {
  workspace: Workspace
  target: AppointmentTarget
  today: LocalDate
  onClose: () => void
}) {
  const { t } = useTranslation(['pro', 'common'])
  const queryClient = useQueryClient()
  const now = useNow(30_000)
  const zone = workspace.business.timeZone
  const scope = { businessId: workspace.businessId, timeZone: zone }
  const day = useStaffDay(workspace.businessId, target.localDate, target.staffId, zone)
  const [mode, setMode] = useState<Mode>({ kind: 'details' })
  const status = useStatusAction(scope, onClose)
  const cancel = useCancelAction(scope)
  const appointment = day.data?.find((candidate) => candidate.id === target.appointmentId)
  // Enter or leave the cancel form without the answer of an earlier attempt (e.g. its AN021).
  // A locked form keeps its unknown outcome: only the same retry or «Κλείσιμο» leave it.
  const toMode = (next: Mode) => {
    if (!cancel.locked) cancel.reset()
    setMode(next)
  }

  const close = () => {
    if (appointment) {
      void invalidateAppointmentChange(queryClient, workspace.businessId, zone, {
        instants: [appointment.startsAt],
      })
    }
    onClose()
  }
  const title = t('appointment.title')

  if (mode.kind === 'move') {
    const canNotify = hasPhone(mode.appointment) && startsInFuture(mode.appointment, now)
    return (
      <Sheet title={t('move.title')} onClose={close}>
        <MoveFlow
          workspace={workspace}
          appointment={mode.appointment}
          today={today}
          canNotify={canNotify}
          onBack={() => setMode({ kind: 'details' })}
          onClose={close}
        />
      </Sheet>
    )
  }

  if (mode.kind === 'cancel') {
    // The appointment as the day shows it NOW: after AN021 the day refetched, and the next attempt
    // must send the current status, not the one the form opened with.
    const current = appointment ?? mode.appointment
    const canNotify = hasPhone(current) && startsInFuture(current, now)
    const done = cancel.result
    return (
      <Sheet title={t('cancel.title')} onClose={close}>
        {done ? (
          <div className={styles.done}>
            <p className={styles.doneTitle} role="status">
              {t('cancel.done')}
            </p>
            {done.notify && !done.smsQueued && (
              <p className={styles.muted}>{t('notify.notSent')}</p>
            )}
            <Button onClick={close} block>
              {t('sheet.done')}
            </Button>
          </div>
        ) : (
          <CancelForm
            appointment={current}
            canNotify={canNotify}
            action={cancel}
            onBack={() => toMode({ kind: 'details' })}
            onClose={close}
          />
        )}
      </Sheet>
    )
  }

  if (day.data === undefined && !day.isError) {
    return (
      <Sheet title={title} onClose={close} busy>
        <span className="visually-hidden" role="status">
          {t('common:loading')}
        </span>
        <Skeleton height={28} width="45%" shape="pill" />
        <Skeleton height={40} width="70%" />
        <Skeleton height={120} shape="card" />
        <Skeleton height={48} shape="pill" />
      </Sheet>
    )
  }

  // Only a day that never loaded is an error here; a failed refetch keeps the appointment and its
  // actions (with a locked retry, if any) on screen.
  if (day.data === undefined || !appointment) {
    return (
      <Sheet title={title} onClose={close}>
        <p role="alert">
          {day.data === undefined
            ? t(rpcFailureMessageKey(failureOf(day.error), 'read'))
            : t('appointment.notFound')}
        </p>
        {day.data === undefined && (
          <Button variant="secondary" onClick={() => void day.refetch()}>
            {t('common:retry')}
          </Button>
        )}
      </Sheet>
    )
  }

  const started = Date.parse(appointment.startsAt) <= now.getTime()
  return (
    <Sheet title={title} onClose={close}>
      {day.isError && (
        <RefreshError failure={failureOf(day.error)} onRetry={() => void day.refetch()} />
      )}
      <AppointmentDetails appointment={appointment} workspace={workspace} />
      <SaveFailure
        failure={status.failure}
        locked={status.locked}
        pending={status.pending}
        onRetry={status.retry}
        onClose={close}
      />
      {!status.locked && (
        <StatusActions
          appointment={appointment}
          started={started}
          action={status}
          canMove={canMove(appointment)}
          onMove={() => setMode({ kind: 'move', appointment })}
          onCancel={() => toMode({ kind: 'cancel', appointment })}
        />
      )}
    </Sheet>
  )
}

function hasPhone(appointment: DayAppointment): boolean {
  return Boolean(appointment.client?.phoneE164)
}

function startsInFuture(appointment: DayAppointment, now: Date): boolean {
  return Date.parse(appointment.startsAt) > now.getTime()
}
