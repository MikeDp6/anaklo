import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/shared/ui/Skeleton'
import styles from './Today.module.css'

/** E17: the day grid while it loads. */
export function DaySkeleton() {
  const { t } = useTranslation()
  return (
    <div className={styles.skeleton} aria-busy="true">
      <p role="status" className="visually-hidden">
        {t('loading')}
      </p>
      <Skeleton height={44} width="60%" shape="pill" />
      <Skeleton height={480} shape="card" />
    </div>
  )
}
