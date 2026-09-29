import { useTranslation } from 'react-i18next'
import styles from './forms.module.css'

/**
 * «Ενημέρωση με SMS» on cancel and move (contract 1.4 §3.5). Shown only when the appointment has
 * a client with a phone and has not started; on by default. Until 1.5 nothing is sent.
 */
export function NotifyToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation('pro')
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.toggleText}>
        <span>{t('notify.label')}</span>
        <span className={styles.muted}>{t('notify.hint')}</span>
      </span>
    </label>
  )
}
