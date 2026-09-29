import { useTranslation } from 'react-i18next'
import { rpcFailureMessageKey, type RpcFailureInfo } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import styles from './RefreshError.module.css'

/**
 * A background refresh failed: what is on screen is the last data that loaded and stays there
 * (with any open sheet); this line says so and offers «Δοκίμασε ξανά» (contract 1.4 §3.6).
 */
export function RefreshError({
  failure,
  onRetry,
}: {
  failure: RpcFailureInfo
  onRetry: () => void
}) {
  const { t } = useTranslation(['pro', 'common'])
  return (
    <div className={styles.refresh} role="status">
      <p>
        <span className={styles.title}>{t('errors.refreshTitle')}</span>{' '}
        {t(rpcFailureMessageKey(failure, 'read'))}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        {t('common:retry')}
      </Button>
    </div>
  )
}
