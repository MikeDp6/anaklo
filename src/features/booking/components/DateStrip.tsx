import { useTranslation } from 'react-i18next'
import type { AppLocale, LocalDate } from '@/shared/lib/localDates'
import { Skeleton } from '@/shared/ui/Skeleton'
import { cx } from '@/shared/ui/cx'
import { dayParts, formatLongDate } from '../format'
import styles from './DateStrip.module.css'

/**
 * A strip of dates (no date picker, phase 1 §1.3): one window of up to 14 days, days without a
 * free time disabled, earlier/later windows at the ends. Also used by the manage link.
 */
export function DateStrip({
  dates,
  available,
  selected,
  loading,
  locale,
  onSelect,
  onEarlier,
  onLater,
}: {
  dates: readonly LocalDate[]
  available: ReadonlySet<LocalDate>
  selected: LocalDate | null
  loading: boolean
  locale: AppLocale
  onSelect: (date: LocalDate) => void
  onEarlier: (() => void) | null
  onLater: (() => void) | null
}) {
  const { t } = useTranslation('booking')
  return (
    <div className={styles.strip} role="group" aria-label={t('slot.dates')}>
      {onEarlier && (
        <button type="button" className={cx(styles.more, 'pressable')} onClick={onEarlier}>
          {t('slot.earlier')}
        </button>
      )}
      {dates.map((date) => {
        if (loading) return <Skeleton key={date} height={76} width={60} shape="pill" />
        const parts = dayParts(date, locale)
        const free = available.has(date)
        return (
          <button
            key={date}
            type="button"
            className={cx(styles.day, 'pressable')}
            aria-pressed={date === selected}
            aria-label={formatLongDate(date, locale)}
            data-date={date}
            disabled={!free}
            onClick={() => onSelect(date)}
          >
            <span className={styles.weekday}>{parts.weekday}</span>
            <span className={styles.number}>{parts.day}</span>
            <span className={styles.month}>{parts.month}</span>
          </button>
        )
      })}
      {onLater && (
        <button type="button" className={cx(styles.more, 'pressable')} onClick={onLater}>
          {t('slot.later')}
        </button>
      )}
    </div>
  )
}
