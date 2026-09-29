import { useTranslation } from 'react-i18next'
import { rpcFailureMessageKey, type RpcFailureInfo } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import styles from './forms.module.css'

/**
 * Why a save failed. With `locked` (offline, timeout: the outcome is unknown) the only ways on
 * are the identical retry (same idempotency key) and «Κλείσιμο», which closes the sheet and
 * reloads the day so it shows whether the change went through (contract 1.4 §0.15).
 */
export function SaveFailure({
  failure,
  locked,
  pending,
  onRetry,
  onClose,
}: {
  failure: RpcFailureInfo | null
  locked: boolean
  pending: boolean
  onRetry: () => void
  onClose: () => void
}) {
  const { t } = useTranslation(['pro', 'common'])
  if (!locked && !failure) return null
  if (!locked && failure) {
    return (
      <p role="alert" className={styles.error}>
        {t(rpcFailureMessageKey(failure))}
      </p>
    )
  }
  return (
    <div role="alert" className={styles.locked}>
      <p className={styles.lockedTitle}>{t('errors.offline')}</p>
      <p className={styles.muted}>{t('errors.offlineHint')}</p>
      <div className={styles.actions}>
        <Button onClick={onRetry} disabled={pending} block>
          {pending ? t('saving') : t('common:retry')}
        </Button>
        <Button variant="secondary" onClick={onClose} block>
          {t('sheet.close')}
        </Button>
      </div>
    </div>
  )
}
