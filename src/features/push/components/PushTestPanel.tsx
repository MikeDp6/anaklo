import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { usePushTest } from '../hooks/usePushTest'
import { PUSH_STATUS_MESSAGE } from '../pushStatus'
import styles from './PushTestPanel.module.css'

/**
 * TEMPORARY (ADR-0010 §3): the push test of step 1.1. The enable button moves to
 * Settings → Notifications in 1.5a; the test button goes away with `spike-push`.
 * `isOwner`: spike-push is for owners only, and it sends to this device's subscription only.
 */
export function PushTestPanel({ isOwner }: { isOwner: boolean }) {
  const { t } = useTranslation('pro')
  const titleId = useId()
  const push = usePushTest()

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        {t('push.title')}
      </h2>
      <p role="status" className={styles.status}>
        {t(PUSH_STATUS_MESSAGE[push.status])}
      </p>
      <Button onClick={push.enable} disabled={!push.canEnable}>
        {t('push.enable')}
      </Button>
      {isOwner && (
        <>
          <button
            type="button"
            className={styles.secondary}
            onClick={push.sendTest}
            disabled={!push.canSendTest}
          >
            {t('push.test')}
          </button>
          {push.testResult && (
            <p role="status" className={styles.status}>
              {t(push.testResult === 'sent' ? 'push.testSent' : 'push.testFailed')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
