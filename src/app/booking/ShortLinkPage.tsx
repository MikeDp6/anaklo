import { useTranslation } from 'react-i18next'
import { BookingSkeleton } from '@/features/booking/components/BookingSkeleton'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { useShortLink } from './useShortLink'

/**
 * `/r/<code>` when the Worker could not resolve it (Supabase did not answer): the page asks
 * `/api` itself and replaces the address with `/<slug>` (contract §8).
 */
export function ShortLinkPage({ code }: { code: string }) {
  const { t } = useTranslation(['booking', 'common'])
  const { state, retry } = useShortLink(code)

  if (state === 'loading') return <BookingSkeleton />
  return (
    <Page>
      {state === 'not-found' ? (
        <Notice headingLevel={1} title={t('notFoundTitle')} body={t('notFoundBody')} />
      ) : (
        <Notice
          tone="error"
          headingLevel={1}
          title={t('errorTitle')}
          body={t('errorBody')}
          action={<Button onClick={retry}>{t('common:retry')}</Button>}
        />
      )}
    </Page>
  )
}
