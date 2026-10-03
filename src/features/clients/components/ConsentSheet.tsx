import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import { Button } from '@/shared/ui/Button'
import { useSetConsent } from '../hooks/useClientMutations'
import styles from './clients.module.css'

/**
 * «Συναίνεση για προσφορές με SMS» (contract 1.8 §4.6): the staff member confirms that the client
 * agreed just now (the text whose version `STAFF_CONSENT_NOTICE_VERSION` names), and whether a
 * parent or guardian gives it. «Καταγραφή συναίνεσης» writes a new record; the sheet closes only
 * once the server answered.
 */
export function ConsentSheet({
  businessId,
  clientId,
  onRecorded,
  onClose,
}: {
  businessId: string
  clientId: string
  onRecorded: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const [guardian, setGuardian] = useState(false)
  const record = useSetConsent(businessId, clientId, onRecorded)
  const busy = record.pending || record.locked
  const close = () => {
    record.reset()
    onClose()
  }
  return (
    <Sheet title={t('clients.consents.sheetTitle')} onClose={close}>
      <div className={styles.stack}>
        <p>{t('clients.consents.confirmBody')}</p>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={guardian}
            disabled={busy}
            onChange={(event) => setGuardian(event.currentTarget.checked)}
          />
          <span>{t('clients.consents.guardian')}</span>
        </label>
        <SaveFailure
          failure={record.failure}
          locked={record.locked}
          pending={record.pending}
          onRetry={record.retry}
          onClose={close}
        />
        {!record.locked && (
          <Button
            block
            disabled={busy}
            onClick={() =>
              record.submit({
                clientId,
                purpose: 'marketing_sms',
                granted: true,
                givenBy: guardian ? 'guardian' : 'client',
              })
            }
          >
            {record.pending ? t('clients.consents.confirming') : t('clients.consents.confirm')}
          </Button>
        )}
      </div>
    </Sheet>
  )
}
