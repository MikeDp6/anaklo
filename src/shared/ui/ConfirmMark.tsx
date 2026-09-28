import styles from './ConfirmMark.module.css'
import { cx } from './cx'

/**
 * E15: the confirmation mark (pop, fading halo, check drawn). Mount it only after the server
 * answered (CLAUDE.md rule 14). `label` from i18n; it is the image's accessible name.
 */
export function ConfirmMark({ label, size = 72 }: { label: string; size?: number }) {
  return (
    <span
      className={styles.mark}
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
    >
      <span className={cx('confirm-halo', styles.halo)} aria-hidden="true" />
      <svg
        className={cx('confirm-pop', styles.svg)}
        viewBox="0 0 48 48"
        aria-hidden="true"
        focusable="false"
      >
        <circle className={styles.disc} cx="24" cy="24" r="24" />
        <path
          className={cx('confirm-check', styles.check)}
          d="M14.5 24.5l6.5 6.5 12.5-13"
          pathLength={48}
        />
      </svg>
    </span>
  )
}
