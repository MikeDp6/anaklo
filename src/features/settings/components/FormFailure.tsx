import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import type { RpcFailureInfo } from '@/shared/lib/rpcError'
import styles from './screens.module.css'

/** The screen's own text for `23P01` (contract 1.6 §3.6). */
export type OverlapKey = 'closures.errors.overlap' | 'timeOff.errors.overlap'

/**
 * Why a settings write failed: an overlap in the screen's own words, anything else as in the 1.4
 * sheets (`SaveFailure`: an unknown outcome locks the form and offers only the identical retry).
 */
export function FormFailure({
  failure,
  locked,
  pending,
  overlapKey,
  onRetry,
  onClose,
}: {
  failure: RpcFailureInfo | null
  locked: boolean
  pending: boolean
  overlapKey?: OverlapKey
  onRetry: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  if (!locked && failure?.kind === 'overlap' && overlapKey) {
    return (
      <p role="alert" className={styles.error}>
        {t(overlapKey)}
      </p>
    )
  }
  return (
    <SaveFailure
      failure={failure}
      locked={locked}
      pending={pending}
      onRetry={onRetry}
      onClose={onClose}
    />
  )
}
