import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/shared/ui/Skeleton'
import styles from './clients.module.css'

/**
 * E17 while the card loads (contract 1.8 §4.3): the name, the rhythm block with its ring and
 * three rows, in the heights of the content so nothing jumps when it arrives (CLS ≈ 0).
 */
export function ClientCardSkeleton() {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.stack} role="status">
      <span className="visually-hidden">{t('clients.card.loading')}</span>
      <Skeleton height={40} width="70%" />
      <Skeleton height={20} width="45%" />
      <div className={styles.section}>
        <div className={styles.rhythm}>
          <Skeleton height={96} width={96} shape="pill" />
          <div className={styles.rhythmText}>
            <Skeleton height={20} />
            <Skeleton height={20} width="60%" />
          </div>
        </div>
        <Skeleton height={48} shape="pill" />
      </div>
      <Skeleton height={72} shape="card" />
      <Skeleton height={72} shape="card" />
      <Skeleton height={72} shape="card" />
    </div>
  )
}
