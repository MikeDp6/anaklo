import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatLongDate, formatTime, useAppLocale } from '@/features/calendar/format'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { DayAppointment, MoveInput } from '@/features/calendar/schema'
import { toLocalDate, type LocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { useAttemptKey } from '../attemptKey'
import { useMoveAction } from '../hooks/useAppointmentActions'
import { d8FlagOf, NO_D8_FLAGS, smsNoteKey, withD8Flag, type D8Flag, type D8Flags } from '../rules'
import { D8Confirm } from './D8Confirm'
import styles from './forms.module.css'
import { NotifyToggle } from './NotifyToggle'
import { SaveFailure } from './SaveFailure'
import { SaveSuccess } from './SaveSuccess'
import { SlotPicker } from './SlotPicker'
import { StaffPicker } from './StaffPicker'

/**
 * Move to a free time from the list (same or another staff member who offers the services),
 * with the SMS option. One key per attempt: a retry after an unknown outcome replays; a changed
 * time, staff member, flag or SMS choice is a new attempt (contract 1.4 §2.6.6).
 */
export function MoveFlow({
  workspace,
  appointment,
  today,
  canNotify,
  onBack,
  onClose,
}: {
  workspace: Workspace
  appointment: DayAppointment
  today: LocalDate
  canNotify: boolean
  onBack: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const zone = workspace.business.timeZone
  const serviceIds = appointment.services.map((line) => line.serviceId)
  const [staffId, setStaffId] = useState(appointment.staffId)
  const [date, setDate] = useState<LocalDate>(() => {
    const own = toLocalDate(new Date(appointment.startsAt), zone)
    return own < today ? today : own
  })
  const [startsAt, setStartsAt] = useState<string | null>(null)
  const [notify, setNotify] = useState(true)
  const [flags, setFlags] = useState<D8Flags>(NO_D8_FLAGS)
  const keyFor = useAttemptKey()
  const move = useMoveAction({ businessId: workspace.businessId, timeZone: zone })
  const busy = move.pending || move.locked
  const d8 = move.failure?.kind === 'domain' ? d8FlagOf(move.failure.code) : null
  const close = () => {
    move.refreshInvolved()
    onClose()
  }
  const clearTime = () => {
    setStartsAt(null)
    setFlags(NO_D8_FLAGS)
    move.reset()
  }
  const offering = workspace.activeStaff.filter((member) =>
    serviceIds.every((id) =>
      workspace.services
        .find((service) => service.id === id)
        ?.offers.some((o) => o.staffId === member.id),
    ),
  )

  const send = (withFlags: D8Flags) => {
    if (!startsAt) return
    const payload: Omit<MoveInput, 'idempotencyKey'> = {
      appointmentId: appointment.id,
      newStartsAt: startsAt,
      newStaffId: staffId === appointment.staffId ? null : staffId,
      notify: canNotify && notify,
      ...withFlags,
    }
    move.submit({ ...payload, idempotencyKey: keyFor(payload), fromStartsAt: appointment.startsAt })
  }
  const confirmD8 = (flag: D8Flag) => {
    const next = withD8Flag(flags, flag)
    setFlags(next)
    send(next)
  }

  if (move.result) {
    const moved = move.result
    const staffName = workspace.staff.find((member) => member.id === moved.staffId)?.displayName
    return (
      <SaveSuccess
        title={t('move.done')}
        summary={t('move.doneSummary', {
          date: formatLongDate(toLocalDate(new Date(moved.startsAt), zone), locale),
          time: formatTime(moved.startsAt, zone, locale),
          staff: staffName ?? '',
        })}
        warnings={moved.warnings}
        smsNote={smsNoteKey(moved)}
        onDone={close}
      />
    )
  }

  return (
    <div className={styles.stack}>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className="visually-hidden">{t('move.title')}</legend>
        <div className={styles.stack}>
          <StaffPicker
            staff={offering}
            selected={staffId}
            disabled={busy}
            onSelect={(id) => {
              setStaffId(id)
              clearTime()
            }}
          />
          <SlotPicker
            businessId={workspace.businessId}
            serviceIds={serviceIds}
            staffId={staffId}
            excludeAppointmentId={appointment.id}
            timeZone={zone}
            today={today}
            date={date}
            selected={startsAt}
            disabled={busy}
            onDateChange={(next) => {
              // A time is always of the day on screen: another day starts without one.
              if (next === date) return
              setDate(next)
              clearTime()
            }}
            onPick={(slot) => {
              setStartsAt(slot.startsAt)
              setFlags(NO_D8_FLAGS)
              move.reset()
            }}
          />
          {canNotify && <NotifyToggle checked={notify} disabled={busy} onChange={setNotify} />}
        </div>
      </fieldset>
      {d8 ? (
        <D8Confirm flag={d8} pending={move.pending} onConfirm={() => confirmD8(d8)} />
      ) : (
        <SaveFailure
          failure={move.failure}
          locked={move.locked}
          pending={move.pending}
          onRetry={move.retry}
          onClose={close}
        />
      )}
      {!move.locked && !d8 && (
        <Button onClick={() => send(flags)} disabled={move.pending || !startsAt} block>
          {move.pending ? t('move.submitting') : t('move.submit')}
        </Button>
      )}
      {!move.locked && (
        <Button variant="secondary" onClick={onBack} disabled={move.pending} block>
          {t('move.back')}
        </Button>
      )}
    </div>
  )
}
