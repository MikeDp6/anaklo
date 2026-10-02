import { useTranslation } from 'react-i18next'
import styles from '@/features/settings/components/screens.module.css'
import { Button } from '@/shared/ui/Button'
import { useShareText } from '../hooks/useShareText'
import type { InviteResult } from '../schema'
import { appUrl, shareText } from '../shareText'
import own from './members.module.css'

/**
 * After `invite-member` answered (rule 14: never before): «{{email}} προστέθηκε.» (or «Ήταν ήδη
 * μέλος.») and the text the owner sends, with «Κοινοποίηση» and «Αντιγραφή κειμένου».
 */
export function InviteDone({
  result,
  businessName,
  onDone,
}: {
  result: InviteResult
  businessName: string
  onDone: () => void
}) {
  const { t } = useTranslation('pro')
  const { t: common } = useTranslation('common')
  const text = shareText(t, {
    businessName,
    appName: common('app.name'),
    email: result.email,
    appUrl: appUrl(window.location.origin),
  })
  const share = useShareText(text)

  return (
    <div className={styles.done}>
      <p role="status" className={styles.status}>
        {result.added ? t('members.added', { email: result.email }) : t('members.alreadyMember')}
      </p>
      <p className={styles.muted}>{t('members.shareIntro')}</p>
      <p className={own.shareText}>{text}</p>
      <div className={styles.actions}>
        {share.canShare && (
          <Button variant="secondary" onClick={share.share}>
            {t('members.share')}
          </Button>
        )}
        <Button variant="secondary" onClick={share.copyText}>
          {t('members.copy')}
        </Button>
      </div>
      {share.copy !== 'idle' && (
        <p role="status" className={share.copy === 'failed' ? styles.error : styles.muted}>
          {t(share.copy === 'copied' ? 'members.copied' : 'members.copyFailed')}
        </p>
      )}
      <Button block onClick={onDone}>
        {t('sheet.done')}
      </Button>
    </div>
  )
}
