import { useTranslation } from 'react-i18next'
import { SettingsHeader } from '@/features/staff/components/SettingsHeader'
import { Page } from '@/shared/ui/Page'
import { useSecurityPage } from '../hooks/useSecurityPage'
import { DevicesSection } from './DevicesSection'
import styles from './mfa.module.css'
import { SignOutAllSection } from './SignOutAllSection'

/**
 * /settings/security, «Ασφάλεια» (contract 1.7 §6.7, D6): every role. Owners and managers see
 * their authenticator devices (add, remove); everyone has «Αποσύνδεση από όλες τις συσκευές».
 * Minimal motion: E16 on taps, E17 while the devices load.
 */
export function SecurityPage() {
  const { t } = useTranslation('pro')
  const page = useSecurityPage()
  return (
    <Page busy={page.managesDevices && !page.ready}>
      <SettingsHeader title={t('security.title')} />
      {page.managesDevices && <p className={styles.lead}>{t('security.intro')}</p>}
      {page.deviceAdded && (
        <p role="status" className={styles.status}>
          {t('security.added')}
        </p>
      )}
      {page.managesDevices && <DevicesSection page={page} />}
      <SignOutAllSection page={page} />
    </Page>
  )
}
