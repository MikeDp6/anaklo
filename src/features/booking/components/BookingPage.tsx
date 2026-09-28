import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { useBusinessPresentation } from '../hooks/useBusinessPresentation'
import { useCatalogue } from '../hooks/useCatalogue'
import { BookingFlowView } from './BookingFlowView'
import { BookingSkeleton } from './BookingSkeleton'

/** `/<slug>`: the online booking page of one business (phase 1 §1.3). */
export function BookingPage({ slug }: { slug: string }) {
  const { t } = useTranslation(['booking', 'common'])
  const { state, retry } = useCatalogue(slug)
  const business = state.status === 'ready' ? state.catalogue.business : null

  useBusinessPresentation({
    theme: business?.theme,
    locale: business?.locale,
    title: business?.name ?? t('common:app.name'),
  })

  switch (state.status) {
    case 'loading':
      return <BookingSkeleton />
    case 'error':
      return (
        <Page>
          <Notice
            tone="error"
            headingLevel={1}
            title={t('errorTitle')}
            body={t('errorBody')}
            action={<Button onClick={retry}>{t('common:retry')}</Button>}
          />
        </Page>
      )
    case 'not-found':
      return (
        <Page>
          <Notice headingLevel={1} title={t('notFoundTitle')} body={t('notFoundBody')} />
        </Page>
      )
    case 'ready':
      return <BookingFlowView catalogue={state.catalogue} />
  }
}
