import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DayAppointment } from '@/features/calendar/schema'
import { CANCEL_REASONS, type CancelReason } from '@/shared/lib/domain'
import { Button } from '@/shared/ui/Button'
import type { AppointmentMutation } from '../hooks/useAppointmentMutation'
import type { CancelVariables } from '../hooks/useAppointmentActions'
import type { CancelResult } from '@/features/calendar/schema'
import styles from './forms.module.css'
import { NotifyToggle } from './NotifyToggle'
import { SaveFailure } from './SaveFailure'

/**
 * Cancel with a reason code (contract 1.4 §2.6.5); «Το ζήτησε ο πελάτης» records the client as
 * the canceller. The SMS option appears only for a future appointment of a client with a phone.
 * Idempotent: a retry of a cancel that went through answers `changed: false`.
 */
export function CancelForm({
  appointment,
  canNotify,
  action,
  onBack,
  onClose,
}: {
  appointment: DayAppointment
  canNotify: boolean
  action: AppointmentMutation<CancelVariables, CancelResult>
  onBack: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const [reason, setReason] = useState<CancelReason>('client_request')
  const [notify, setNotify] = useState(true)
  const busy = action.pending || action.locked

  const submit = () =>
    action.submit({
      appointmentId: appointment.id,
      fromStatus: appointment.status,
      reason,
      notify: canNotify && notify,
      startsAt: appointment.startsAt,
    })

  return (
    <div className={styles.stack}>
      <fieldset className={styles.fieldset} disabled={busy}>
        <legend className={styles.legend}>{t('cancel.reason')}</legend>
        {CANCEL_REASONS.map((code) => (
          <label key={code} className={styles.option}>
            <span className={styles.optionTitle}>{t(`cancel.reasons.${code}`)}</span>
            <input
              className={styles.radio}
              type="radio"
              name="cancel-reason"
              value={code}
              checked={reason === code}
              onChange={() => setReason(code)}
            />
          </label>
        ))}
        {canNotify && <NotifyToggle checked={notify} disabled={busy} onChange={setNotify} />}
      </fieldset>
      <SaveFailure
        failure={action.failure}
        locked={action.locked}
        pending={action.pending}
        onRetry={action.retry}
        onClose={onClose}
      />
      {!action.locked && (
        <>
          <Button onClick={submit} disabled={action.pending} block>
            {action.pending ? t('cancel.submitting') : t('cancel.submit')}
          </Button>
          <Button variant="secondary" onClick={onBack} disabled={action.pending} block>
            {t('cancel.keep')}
          </Button>
        </>
      )}
    </div>
  )
}
