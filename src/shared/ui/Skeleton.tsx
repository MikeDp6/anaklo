import styles from './Skeleton.module.css'
import { cx } from './cx'

/** Placeholder block while content loads (skeletons, not spinners): E17 sand shimmer. */
export function Skeleton({
  height,
  width = '100%',
  shape = 'control',
}: {
  height: number | string
  width?: number | string
  /** Corner radius: `control` (fields, rows), `card`, or `pill` (buttons, chips). */
  shape?: 'control' | 'card' | 'pill'
}) {
  return (
    <span
      className={cx('skeleton', styles.skeleton, styles[shape])}
      style={{ height, width }}
      aria-hidden="true"
    />
  )
}
