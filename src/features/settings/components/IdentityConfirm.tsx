import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Button } from '@/shared/ui/Button'
import type { IdentityFormState } from '../hooks/useIdentityForm'
import type { FieldChange } from '../identity'
import styles from './screens.module.css'

/**
 * The confirmation step (contract 1.7 §6.9): only the changed fields, each with what it does,
 * then «Επιβεβαίωση αλλαγών». The code sheet opens only if the server asks for a fresh code; the
 * result shows only from the server's answer (rule 14). AN024/AN025 show their own texts.
 */
export function IdentityConfirm({
  state,
  changes,
}: {
  state: IdentityFormState
  changes: readonly FieldChange[]
}) {
  const { t } = useTranslation('pro')
  const { change } = state

  return (
    <div className={styles.stack}>
      <h2 className={styles.title}>{t('identity.confirmTitle')}</h2>
      <ul className={styles.list}>
        {changes.map((item) => (
          <li key={item.field} className={styles.item}>
            <span className={styles.title}>{t(`identity.${item.field}`)}</span>
            <span className={styles.meta}>
              {t('identity.change', { from: item.from, to: item.to })}
            </span>
            <span>{t(`identity.consequences.${item.field}`)}</span>
          </li>
        ))}
      </ul>
      <SaveFailure
        failure={change.failure}
        locked={change.locked}
        pending={change.pending}
        onRetry={change.retry}
        onClose={state.back}
      />
      {!change.locked && (
        <div className={styles.stack}>
          <Button block disabled={change.pending} onClick={state.confirm}>
            {change.pending ? t('identity.saving') : t('identity.confirm')}
          </Button>
          <Button variant="secondary" block disabled={change.pending} onClick={state.back}>
            {t('identity.back')}
          </Button>
        </div>
      )}
    </div>
  )
}
