import styles from './ProgressBar.module.css'
import { cx } from './cx'

/**
 * E19: progress through the booking steps. The fill moves with transform: scaleX only.
 * `label` (and `valueText`, e.g. «Βήμα 2 από 4») come from i18n.
 */
export function ProgressBar({
  value,
  max,
  label,
  valueText,
}: {
  value: number
  max: number
  label: string
  valueText?: string
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <div className={cx('progress-bar', styles.bar)} style={{ transform: `scaleX(${ratio})` }} />
    </div>
  )
}
