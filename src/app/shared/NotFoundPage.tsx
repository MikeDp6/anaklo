import { useTranslation } from 'react-i18next'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'

export function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <Page>
      <Notice
        headingLevel={1}
        title={t('errors.pageNotFoundTitle')}
        body={t('errors.pageNotFoundBody')}
      />
    </Page>
  )
}
