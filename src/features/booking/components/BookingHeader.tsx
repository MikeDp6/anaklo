import { useTranslation } from 'react-i18next'
import { ProgressBar } from '@/shared/ui/ProgressBar'
import { cx } from '@/shared/ui/cx'
import { useScrolled } from '../hooks/useScrolled'
import styles from './BookingHeader.module.css'

/**
 * E13: a sticky header, transparent at the top; after 80px of scrolling it gets a cream 90%
 * background with blur (250ms). Back button, the business name (hidden on the first step while
 * the cover shows it) and the E19 progress bar.
 */
export function BookingHeader({
  name,
  showName,
  onBack,
  progress,
}: {
  name: string
  showName: boolean
  /** null: no way back from here (first step, confirmation, a request running). */
  onBack: (() => void) | null
  progress: { value: number; max: number }
}) {
  const { t } = useTranslation('booking')
  const { sentinel, scrolled } = useScrolled()
  const done = progress.value >= progress.max
  const valueText = done
    ? t('header.complete')
    : t('header.stepOf', { current: progress.value + 1, total: progress.max })

  return (
    <>
      <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
      <header className={styles.header} data-scrolled={scrolled}>
        <div className={styles.row}>
          {onBack ? (
            <button
              type="button"
              className={cx(styles.back, 'pressable')}
              aria-label={t('header.back')}
              onClick={onBack}
            >
              <span className={styles.arrow} aria-hidden="true" />
            </button>
          ) : (
            <span className={styles.placeholder} />
          )}
          <p className={styles.name} data-visible={showName || scrolled} aria-hidden={!showName}>
            {name}
          </p>
        </div>
        <ProgressBar
          value={progress.value}
          max={progress.max}
          label={t('header.progress')}
          valueText={valueText}
        />
      </header>
    </>
  )
}
