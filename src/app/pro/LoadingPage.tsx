import { useTranslation } from 'react-i18next'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'

/** Shown while the first route guards run (session, membership). Skeletons, not spinners. */
export function LoadingPage() {
  const { t } = useTranslation()
  return (
    <Page busy>
      <p role="status" className="visually-hidden">
        {t('common.loading')}
      </p>
      <Skeleton height={32} width="40%" />
      <Skeleton height={112} />
      <Skeleton height={48} />
    </Page>
  )
}
