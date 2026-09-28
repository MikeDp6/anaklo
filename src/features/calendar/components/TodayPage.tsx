import { useTranslation } from 'react-i18next'
import { useMember } from '@/features/auth/hooks/useMember'
import { PushTestPanel } from '@/features/push/components/PushTestPanel'
import { isPushTestEnabled } from '@/features/push/env'
import { Notice } from '@/shared/ui/Notice'
import { Page } from '@/shared/ui/Page'

export function TodayPage() {
  const { t } = useTranslation(['pro', 'common'])
  const { membership } = useMember()
  return (
    <Page>
      <h1>{t('todayTitle')}</h1>
      <Notice title={t('common:app.name')} body={t('todayPlaceholder')} />
      {/* TEMPORARY push test of step 1.1 (ADR-0010 §3); spike-push is for owners only. */}
      {isPushTestEnabled() && <PushTestPanel isOwner={membership.role === 'owner'} />}
    </Page>
  )
}
