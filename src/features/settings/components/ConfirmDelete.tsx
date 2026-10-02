import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import styles from './screens.module.css'

/**
 * «Διαγραφή» with one confirmation («Να διαγραφεί;» → «Διαγραφή» / «Άκυρο»). The deletion runs
 * only on the second tap; the caller shows the result only after the server answered.
 */
export function ConfirmDelete({
  confirming,
  busy,
  label,
  onAsk,
  onCancel,
  onConfirm,
}: {
  confirming: boolean
  busy: boolean
  /** The accessible name of the first button when «Διαγραφή» alone is ambiguous (a list item). */
  label?: string
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('pro')
  if (!confirming) {
    return (
      <Button variant="secondary" block disabled={busy} aria-label={label} onClick={onAsk}>
        {t('form.delete')}
      </Button>
    )
  }
  return (
    <div className={styles.stack}>
      <p className={styles.status}>{t('form.confirmDelete')}</p>
      <div className={styles.actions}>
        <Button variant="secondary" disabled={busy} onClick={onConfirm}>
          {t('form.delete')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </div>
  )
}
