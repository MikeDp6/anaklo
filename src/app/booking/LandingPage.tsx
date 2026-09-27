import { useTranslation } from 'react-i18next'
import { Page } from '@/shared/ui/Page'

export function LandingPage() {
  const { t } = useTranslation()
  return (
    <Page>
      <h1>{t('app.name')}</h1>
      <p>{t('app.tagline')}</p>
      <p>{t('landing.body')}</p>
    </Page>
  )
}
