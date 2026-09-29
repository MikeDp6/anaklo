import { useTranslation } from 'react-i18next'
import type { LocalDate } from '@/shared/lib/dates'
import { cx } from '@/shared/ui/cx'
import { formatLongDate, useAppLocale } from '../format'
import styles from './DayHeader.module.css'

/** The shown day with previous / next and a way back to today. */
export function DayHeader({
  date,
  isToday,
  onPrevious,
  onNext,
  onToday,
}: {
  date: LocalDate
  isToday: boolean
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  return (
    <div className={styles.header}>
      <button
        type="button"
        className={cx(styles.arrow, 'pressable')}
        onClick={onPrevious}
        aria-label={t('day.previous')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <div className={styles.label}>
        <p className={styles.date} aria-live="polite" data-testid="day-date" data-date={date}>
          {formatLongDate(date, locale)}
        </p>
        {!isToday && (
          <button type="button" className={cx(styles.today, 'pressable')} onClick={onToday}>
            {t('day.today')}
          </button>
        )}
      </div>
      <button
        type="button"
        className={cx(styles.arrow, 'pressable')}
        onClick={onNext}
        aria-label={t('day.next')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  )
}
