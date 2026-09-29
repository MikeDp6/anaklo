import { useTranslation } from 'react-i18next'
import type { BookingWarning } from '@/features/calendar/schema'
import { Button } from '@/shared/ui/Button'
import { ConfirmMark } from '@/shared/ui/ConfirmMark'
import styles from './forms.module.css'

/**
 * The success state of a booking or a move. Rendered only from the server's answer (rule 14), so
 * E15 (ConfirmMark) never plays before the change is saved.
 */
export function SaveSuccess({
  title,
  summary,
  warnings,
  smsNotSent,
  onDone,
}: {
  title: string
  summary: string
  warnings: readonly BookingWarning[]
  /** The user asked for an SMS and none was queued (always so until 1.5). */
  smsNotSent: boolean
  onDone: () => void
}) {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.done}>
      <ConfirmMark label={title} />
      <p className={styles.doneTitle} role="status">
        {title}
      </p>
      <p>{summary}</p>
      {warnings.map((warning) => (
        <p key={warning} className={styles.warning}>
          {t(`d8.warning.${warning}`)}
        </p>
      ))}
      {smsNotSent && <p className={styles.muted}>{t('notify.notSent')}</p>}
      <Button onClick={onDone} block>
        {t('sheet.done')}
      </Button>
    </div>
  )
}
