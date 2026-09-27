import { useTranslation } from 'react-i18next'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'

export function TodayPage() {
  const { t } = useTranslation()
  return (
    <Page>
      <h1>{t('pro.todayTitle')}</h1>
      <Notice title={t('app.name')} body={t('pro.todayPlaceholder')} />
    </Page>
  )
}
