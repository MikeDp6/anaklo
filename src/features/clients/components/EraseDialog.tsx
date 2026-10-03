import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import { Button } from '@/shared/ui/Button'
import { useEraseClient } from '../hooks/useClientMutations'
import styles from './clients.module.css'

const CONSEQUENCES = ['details', 'notes', 'appointments', 'marketing', 'final'] as const

/**
 * «Ανωνυμοποίηση πελάτη» (contract 1.8 §4.8): what it does, written before the button; a checkbox
 * «Καταλαβαίνω ότι δεν αναιρείται.» enables «Ανωνυμοποίηση». The call goes through `useStepUp`:
 * the app never asks for a code first; when the server asks (`aal2_required` or
 * `fresh_totp_required`) the code sheet opens over this one and the call runs exactly once more.
 * Success only after the answer, then back to «Πελάτες» with a notice; a failure stays here.
 */
export function EraseDialog({
  businessId,
  clientId,
  onClose,
}: {
  businessId: string
  clientId: string
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const [understood, setUnderstood] = useState(false)
  const erase = useEraseClient(businessId)
  const busy = erase.pending || erase.locked
  const close = () => {
    erase.reset()
    onClose()
  }
  // While the erase is in flight the dialog cannot be closed (X, Esc, «Άκυρο»): the answer, also
  // a success, lands here and nowhere else.
  return (
    <Sheet title={t('clients.erase.title')} onClose={close} closable={!erase.pending}>
      <div className={styles.stack}>
        <p className={styles.status}>{t('clients.erase.lead')}</p>
        <ul className={styles.consequences}>
          {CONSEQUENCES.map((item) => (
            <li key={item}>{t(`clients.erase.consequences.${item}`)}</li>
          ))}
        </ul>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={understood}
            disabled={busy}
            onChange={(event) => setUnderstood(event.currentTarget.checked)}
          />
          <span>{t('clients.erase.understand')}</span>
        </label>
        <SaveFailure
          failure={erase.failure}
          locked={erase.locked}
          pending={erase.pending}
          onRetry={erase.retry}
          onClose={close}
        />
        {!erase.locked && (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              className={styles.danger}
              disabled={!understood || busy}
              onClick={() => erase.submit(clientId)}
            >
              {erase.pending ? t('clients.erase.erasing') : t('clients.erase.confirm')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={close}>
              {t('clients.erase.cancel')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
