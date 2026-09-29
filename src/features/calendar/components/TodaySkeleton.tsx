import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/shared/ui/Skeleton'
import styles from './Today.module.css'

/** E17: the shape of «Σήμερα» while it loads (skeletons, not spinners). */
export function TodaySkeleton() {
  const { t } = useTranslation()
  return (
    <div className={styles.skeleton} aria-busy="true">
      <p role="status" className="visually-hidden">
        {t('loading')}
      </p>
      <div className={styles.stats}>
        <Skeleton height={176} shape="card" />
        <Skeleton height={176} shape="card" />
      </div>
      <Skeleton height={24} width="30%" shape="pill" />
      <Skeleton height={64} />
      <Skeleton height={64} />
      <Skeleton height={24} width="25%" shape="pill" />
      <Skeleton height={64} />
    </div>
  )
}
