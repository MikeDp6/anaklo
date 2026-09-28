// TEMPORARY (step 1.1 spike): see ./api.ts. Loaded lazily only with `?spike=td`.
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { Notice } from '@/shared/ui/Notice'
import type { SpikeTdStatus } from './api'
import { useTrustedDeviceSpike } from './useTrustedDeviceSpike'
import styles from './SpikeTdPanel.module.css'

const STATUS_KEYS = {
  trusted: 'spike.trusted',
  issued: 'spike.issued',
  none: 'spike.none',
} as const satisfies Record<SpikeTdStatus, string>

export default function SpikeTdPanel() {
  const { t } = useTranslation()
  const spike = useTrustedDeviceSpike()

  const body = spike.isFetching
    ? t('spike.checking')
    : spike.isError
      ? t('spike.error')
      : t(STATUS_KEYS[spike.data ?? 'none'])

  return (
    <aside className={styles.panel} aria-live="polite">
      <Notice
        tone={spike.isError ? 'error' : 'info'}
        title={t('spike.title')}
        body={body}
        action={
          <Button onClick={() => void spike.refetch()} disabled={spike.isFetching}>
            {t('spike.again')}
          </Button>
        }
      />
    </aside>
  )
}
