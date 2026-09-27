import styles from './Skeleton.module.css'

/** Placeholder block shown while content loads (skeletons, not spinners). */
export function Skeleton({ height, width = '100%' }: { height: number; width?: number | string }) {
  return <span className={styles.skeleton} style={{ height, width }} aria-hidden="true" />
}
