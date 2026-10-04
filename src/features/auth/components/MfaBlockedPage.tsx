import { useTranslation } from 'react-i18next'
import styles from './mfa.module.css'
import { MfaFrame } from './MfaFrame'
import { SupportContactLinks } from './SupportContactLinks'

/**
 * /mfa/blocked, «Επικοινώνησε με τη Nous» (contract 1.9b §4.3, C3/C6): a device was removed from
 * the account without going through the app and none is left, so the server refuses a new one
 * until Nous has checked the person and reset the account (`mfa-reset`). In plain words what
 * happened and how to reach Nous (the contact links of «Χάσατε τη συσκευή σας;»). Never the wizard,
 * never a code field: the only actions are the contact links and the frame's «Αποσύνδεση». The
 * route guard runs again on every return to the app, so after the reset (which ends every
 * session) the user signs in and enrols. Minimal motion: E16 on the links only.
 */
export function MfaBlockedPage() {
  const { t } = useTranslation('pro')
  return (
    <MfaFrame title={t('mfa.blocked.title')} intro={t('mfa.blocked.body')}>
      <section className={styles.section}>
        <p>{t('mfa.blocked.contact')}</p>
        <SupportContactLinks />
        <p className={styles.status}>{t('mfa.lostDevice.noBypass')}</p>
      </section>
    </MfaFrame>
  )
}
