import { useTranslation } from 'react-i18next'
import { Link, Navigate } from 'react-router'
import { LoadError } from '@/features/calendar/components/LoadError'
import { failedWithoutData } from '@/features/calendar/queryState'
import { ListSkeleton } from '@/features/settings/components/SettingsScreen'
import { failureOf } from '@/shared/lib/rpcError'
import { cx } from '@/shared/ui/cx'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import { useAddDevice } from '../hooks/useAddDevice'
import { SECURITY_PATH } from '../loaders'
import { EnrollWizard } from './EnrollWizard'
import styles from './mfa.module.css'

/**
 * /settings/security/add-device (contract 1.7 §6.1, §6.4): the wizard in mode `add` for an owner
 * or manager; staff go back to «Ασφάλεια». The permission needs a fresh code (the code sheet when
 * the server asks). Back on «Ασφάλεια» with «Η συσκευή προστέθηκε.» once verified.
 */
export function AddDevicePage() {
  const { t } = useTranslation('pro')
  const page = useAddDevice()
  if (!page.managesDevices) return <Navigate to={SECURITY_PATH} replace />
  return (
    <Page busy={page.factors.data === undefined}>
      <header className={styles.header}>
        <Link
          to={SECURITY_PATH}
          className={cx(styles.link, 'pressable')}
          aria-label={t('security.backLabel')}
        >
          {t('security.back')}
        </Link>
        <DisplayTitle size="md">{t('security.add')}</DisplayTitle>
      </header>
      <p className={styles.lead}>{t('security.addIntro')}</p>
      {failedWithoutData(page.factors) ? (
        <LoadError
          failure={failureOf(page.factors.error)}
          onRetry={() => void page.factors.refetch()}
        />
      ) : page.factors.data === undefined ? (
        <ListSkeleton label={t('security.devicesLoading')} rows={2} />
      ) : (
        <EnrollWizard
          mode="add"
          userId={page.userId}
          verifiedCount={page.factors.data.length}
          onDone={page.done}
        />
      )}
    </Page>
  )
}
