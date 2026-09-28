import { useTranslation } from 'react-i18next'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'

/** E17 while a step's code loads (the lazy chunk, normally prefetched). */
export function StepSkeleton() {
  const { t } = useTranslation()
  return (
    <div aria-busy="true">
      <p role="status" className="visually-hidden">
        {t('loading')}
      </p>
      <Skeleton height={20} width="40%" />
      <Skeleton height={40} width="80%" />
      <Skeleton height={160} shape="card" />
    </div>
  )
}

/** E17 while the catalogue loads (only when the Worker could not inject it). */
export function BookingSkeleton() {
  const { t } = useTranslation()
  return (
    <Page busy>
      <p role="status" className="visually-hidden">
        {t('loading')}
      </p>
      <Skeleton height={220} shape="card" />
      <Skeleton height={20} width="40%" />
      <Skeleton height={64} shape="card" />
      <Skeleton height={64} shape="card" />
      <Skeleton height={64} shape="card" />
    </Page>
  )
}
