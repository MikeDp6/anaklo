import { useTranslation } from 'react-i18next'
import { rpcFailureMessageKey, type RpcFailureInfo } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'

/** A read failed: the reason and «Δοκίμασε ξανά» (queries are never shown as empty). */
export function LoadError({
  failure,
  onRetry,
  headingLevel = 2,
}: {
  failure: RpcFailureInfo
  onRetry: () => void
  headingLevel?: 1 | 2
}) {
  const { t } = useTranslation(['pro', 'common'])
  return (
    <Notice
      tone="error"
      headingLevel={headingLevel}
      title={t('errors.loadTitle')}
      body={t(rpcFailureMessageKey(failure, 'read'))}
      action={
        <Button variant="secondary" onClick={onRetry}>
          {t('common:retry')}
        </Button>
      }
    />
  )
}
