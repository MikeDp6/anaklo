import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cx } from '@/shared/ui/cx'
import { useMfaRoute } from '../hooks/useMfaRoute'
import { MFA_CHALLENGE_PATH, withNext } from '../loaders'
import styles from './mfa.module.css'
import { MfaFrame } from './MfaFrame'
import { SupportContactLinks } from './SupportContactLinks'

/**
 * /mfa/lost-device, «Χάσατε τη συσκευή σας;» (contract 1.7 §6.5, plan 1.7): with a second device,
 * its code (back to the code screen); always Nous's contact (`VITE_SUPPORT_*`; a missing one is
 * hidden) and how Nous checks it is you. There is no way in without a device: no bypass of any
 * kind on this screen, only links back and «Αποσύνδεση».
 */
export function LostDevicePage() {
  const { t } = useTranslation('pro')
  const { verifiedFactors, next } = useMfaRoute()
  const challenge = withNext(MFA_CHALLENGE_PATH, next)
  const hasSecondDevice = verifiedFactors.length >= 2
  return (
    <MfaFrame title={t('mfa.lostDevice.title')}>
      {hasSecondDevice && (
        <section className={styles.section}>
          <p className={styles.lead}>{t('mfa.lostDevice.secondDeviceHint')}</p>
          <Link to={challenge} className={cx(styles.link, 'pressable')}>
            {t('mfa.lostDevice.secondDevice')}
          </Link>
        </section>
      )}
      <section className={styles.section}>
        <p>{t('mfa.lostDevice.contact')}</p>
        <SupportContactLinks />
        <p className={styles.status}>{t('mfa.lostDevice.noBypass')}</p>
      </section>
      {!hasSecondDevice && (
        <div className={styles.links}>
          <Link to={challenge} className={cx(styles.link, 'pressable')}>
            {t('mfa.lostDevice.back')}
          </Link>
        </div>
      )}
    </MfaFrame>
  )
}
