import { useTranslation } from 'react-i18next'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'

export function LandingPage() {
  const { t } = useTranslation(['booking', 'common'])
  return (
    <Page>
      <DisplayTitle as="h1" size="xl" animate>
        {t('common:app.name')}
      </DisplayTitle>
      <p>{t('landing.tagline')}</p>
      <p>{t('landing.body')}</p>
    </Page>
  )
}
