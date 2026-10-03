import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { cx } from '@/shared/ui/cx'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { useClientCardPage } from '../hooks/useClientCardPage'
import { ClientCardSkeleton } from './ClientCardSkeleton'
import { ClientCardView } from './ClientCardView'
import styles from './clients.module.css'

/**
 * The client card (contract 1.8 §4.3): E17 until it loads; a merged client redirects to the one
 * it was merged into; an erased one shows only that it was erased; a live one the whole card.
 */
export function ClientCardPage() {
  const { t } = useTranslation('pro')
  const { state, businessId, userId, back } = useClientCardPage()

  if (state.kind === 'ready' && state.card.state === 'merged') {
    return <Navigate to={`/clients/${state.card.mergedIntoId}`} replace state={{ back }} />
  }

  return (
    <Page busy={state.kind === 'loading'}>
      <Link
        to={back}
        className={cx(styles.back, 'pressable')}
        aria-label={t('clients.card.backLabel')}
      >
        <span className={styles.backChevron} aria-hidden="true" />
        {t('clients.card.back')}
      </Link>
      {state.kind === 'notFound' ? (
        <Notice
          headingLevel={1}
          title={t('clients.card.notFound')}
          body={t('clients.card.notFoundBody')}
        />
      ) : state.kind === 'error' ? (
        <LoadError failure={state.failure} onRetry={state.retry} headingLevel={1} />
      ) : state.kind === 'loading' ? (
        <ClientCardSkeleton />
      ) : (
        <>
          {state.refreshFailure && (
            <RefreshError failure={state.refreshFailure} onRetry={state.retry} />
          )}
          {state.card.state === 'erased' ? (
            <Notice
              headingLevel={1}
              title={t('clients.card.erasedTitle')}
              body={t('clients.card.erasedBody')}
            />
          ) : (
            state.card.state === 'live' && (
              <ClientCardView businessId={businessId} userId={userId} card={state.card} />
            )
          )}
        </>
      )}
    </Page>
  )
}
