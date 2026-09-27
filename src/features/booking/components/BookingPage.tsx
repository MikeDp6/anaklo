import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useBusinessPresentation } from '../hooks/useBusinessPresentation'
import { usePublicProfile } from '../hooks/usePublicProfile'
import styles from './BookingPage.module.css'

export function BookingPage({ slug }: { slug: string }) {
  const { t } = useTranslation()
  const profile = usePublicProfile(slug)

  useBusinessPresentation({
    theme: profile.data?.theme,
    locale: profile.data?.locale,
    title: profile.data?.name ?? t('app.name'),
  })

  if (profile.isPending) {
    return (
      <Page busy>
        <p role="status" className="visually-hidden">
          {t('common.loading')}
        </p>
        <Skeleton height={112} />
        <Skeleton height={24} width="70%" />
        <Skeleton height={48} />
      </Page>
    )
  }

  if (profile.isError) {
    return (
      <Page>
        <Notice
          tone="error"
          headingLevel={1}
          title={t('booking.errorTitle')}
          body={t('booking.errorBody')}
          action={<Button onClick={() => void profile.refetch()}>{t('common.retry')}</Button>}
        />
      </Page>
    )
  }

  if (!profile.data) {
    return (
      <Page>
        <Notice
          headingLevel={1}
          title={t('booking.notFoundTitle')}
          body={t('booking.notFoundBody')}
        />
      </Page>
    )
  }

  return (
    <Page>
      <header className={styles.header}>
        <h1 className={styles.name}>{profile.data.name}</h1>
      </header>
      <p className={styles.lead}>{t('booking.comingSoon')}</p>
    </Page>
  )
}
