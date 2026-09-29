import { useTranslation } from 'react-i18next'
import type { DayAppointment, StatusTarget } from '@/features/calendar/schema'
import { Button } from '@/shared/ui/Button'
import type { AppointmentMutation } from '../hooks/useAppointmentMutation'
import type { StatusVariables } from '../hooks/useAppointmentActions'
import type { StatusResult } from '@/features/calendar/schema'
import { statusTargets } from '../rules'
import styles from './forms.module.css'

const LABEL_KEYS = {
  confirmed: 'appointment.actions.confirm',
  completed: 'appointment.actions.complete',
  no_show: 'appointment.actions.noShow',
} as const

/**
 * Confirm / «Ήρθε» / «Δεν ήρθε», and the corrections between completed and no-show. Each tap
 * sends the status the sheet showed (`p_from_status`): a change made meanwhile on another device
 * comes back as AN021 instead of being overwritten.
 */
export function StatusActions({
  appointment,
  started,
  action,
  canMove,
  onMove,
  onCancel,
}: {
  appointment: DayAppointment
  started: boolean
  action: AppointmentMutation<StatusVariables, StatusResult>
  canMove: boolean
  onMove: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('pro')
  const targets = statusTargets(appointment, started)
  const correcting = appointment.status === 'completed' || appointment.status === 'no_show'
  const pendingTarget = action.pending ? action.variables?.status : undefined

  const send = (status: StatusTarget) =>
    action.submit({
      appointmentId: appointment.id,
      fromStatus: appointment.status,
      status,
      startsAt: appointment.startsAt,
    })

  return (
    <div className={styles.actions}>
      {correcting && targets.length > 0 && (
        <p className={styles.sectionTitle}>{t('appointment.correction')}</p>
      )}
      <div className={styles.row}>
        {targets.map((status, index) => (
          <Button
            key={status}
            variant={index === 0 && !correcting ? 'primary' : 'secondary'}
            onClick={() => send(status)}
            disabled={action.pending || action.locked}
          >
            {pendingTarget === status ? t('saving') : t(LABEL_KEYS[status])}
          </Button>
        ))}
      </div>
      {canMove && (
        <Button variant="secondary" onClick={onMove} disabled={action.pending || action.locked}>
          {t('appointment.actions.move')}
        </Button>
      )}
      {appointment.status !== 'cancelled' && (
        <Button variant="secondary" onClick={onCancel} disabled={action.pending || action.locked}>
          {t('appointment.actions.cancel')}
        </Button>
      )}
    </div>
  )
}
