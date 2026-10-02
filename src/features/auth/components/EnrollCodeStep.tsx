import { useTranslation } from 'react-i18next'
import type { EnrollWizardState } from '../hooks/useEnrollWizard'
import styles from './mfa.module.css'
import { VerifyCodeForm } from './VerifyCodeForm'

/**
 * Step 3: «Γράψε τον κωδικό 6 ψηφίων» of the new device (contract 1.7 §6.4). Done only after
 * GoTrue verified it. «Πίσω στον κωδικό QR» while the QR is still on this page; «Ξεκίνα από την
 * αρχή» removes this unverified device and goes back to step 1.
 */
export function EnrollCodeStep({ wizard }: { wizard: EnrollWizardState }) {
  const { t } = useTranslation('pro')
  const factorId = wizard.factorId
  if (!factorId) return null
  return (
    <div className={styles.stack}>
      <h2 className={styles.stepTitle}>{t('mfa.enroll.code.title')}</h2>
      <p className={styles.lead}>{t('mfa.enroll.code.body')}</p>
      <VerifyCodeForm
        factors={[]}
        factorId={factorId}
        purpose="signIn"
        onVerified={wizard.verified}
        submitLabel={t('mfa.enroll.code.submit')}
        verifyingLabel={t('mfa.enroll.code.verifying')}
      >
        <div className={styles.links}>
          {wizard.backToScan && (
            <button
              type="button"
              className={`${styles.link} pressable`}
              onClick={wizard.backToScan}
            >
              {t('mfa.enroll.code.back')}
            </button>
          )}
          <button type="button" className={`${styles.link} pressable`} onClick={wizard.restart}>
            {t('mfa.restart')}
          </button>
        </div>
      </VerifyCodeForm>
    </div>
  )
}
