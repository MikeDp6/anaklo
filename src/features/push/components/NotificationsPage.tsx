import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useNotificationsSettings } from '../hooks/useNotificationsSettings'
import { PUSH_STATUS_MESSAGE, type PushStatus } from '../pushStatus'
import styles from './NotificationsPage.module.css'

/**
 * /settings/notifications (contract 1.5 §4.1, ADR-0010 §7): what push does, this device's status,
 * one primary action («Ενεργοποίηση», or the test push once on). Minimal motion: G3 buttons with
 * E16, an E17 skeleton for the status line while it loads; nothing else moves.
 */
export function NotificationsPage() {
  const { t } = useTranslation('pro')
  const push = useNotificationsSettings()
  return (
    <Page busy={push.status === 'loading'}>
      <header className={styles.header}>
        <Eyebrow>{t('settings.title')}</Eyebrow>
        <DisplayTitle size="md">{t('push.title')}</DisplayTitle>
      </header>
      <p className={styles.intro}>{t('push.intro')}</p>
      <section className={styles.panel} aria-label={t('push.title')}>
        <StatusLine status={push.status} />
        {push.action === 'enable' && (
          <Button block onClick={push.enable} disabled={push.enabling}>
            {t('push.enable')}
          </Button>
        )}
        {push.action === 'test' && (
          <Button block onClick={push.sendTest} disabled={push.testing}>
            {t('push.test')}
          </Button>
        )}
        {push.testMessage && (
          <p role="status" className={styles.muted}>
            {t(push.testMessage)}
          </p>
        )}
      </section>
    </Page>
  )
}

function StatusLine({ status }: { status: PushStatus }) {
  const { t } = useTranslation('pro')
  if (status === 'loading') {
    return (
      <p role="status" className={styles.status}>
        <span className="visually-hidden">{t('push.statusLoading')}</span>
        <Skeleton height={22} width="70%" />
      </p>
    )
  }
  return (
    <p role="status" className={styles.status} data-status={status}>
      {t(PUSH_STATUS_MESSAGE[status])}
    </p>
  )
}
