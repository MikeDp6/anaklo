import { useTranslation } from 'react-i18next'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'
import { SignOutButton } from './SignOutButton'

/** Signed in, but not a member of any business (ADR-0009 §10). */
export function NoAccessPage() {
  const { t } = useTranslation(['pro', 'common'])
  return (
    <Page>
      <Eyebrow>{t('common:app.name')}</Eyebrow>
      <Notice
        headingLevel={1}
        title={t('noAccess.title')}
        body={t('noAccess.body')}
        action={<SignOutButton />}
      />
    </Page>
  )
}
