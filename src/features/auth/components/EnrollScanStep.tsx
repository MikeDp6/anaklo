import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { ButtonLink } from '@/shared/ui/ButtonLink'
import type { EnrollWizardState } from '../hooks/useEnrollWizard'
import styles from './mfa.module.css'

/**
 * Step 2: «Σκάναρε τον κωδικό QR» (contract 1.7 §6.4). GoTrue's QR is an SVG data URI shown only
 * as an `<img>` (never inline markup); anything else shows no image, only the key. On the same
 * phone: «Άνοιγμα στην εφαρμογή κωδικών» (`otpauth://`) or «Αντιγραφή κλειδιού». Any of the three
 * marks the enrolment as waiting for its code (a reload resumes at step 3).
 */
export function EnrollScanStep({ wizard }: { wizard: EnrollWizardState }) {
  const { t } = useTranslation(['pro', 'common'])
  const enrollment = wizard.enrollment
  if (!enrollment) return null
  return (
    <div className={styles.stack}>
      <h2 className={styles.stepTitle}>{t('mfa.enroll.scan.title')}</h2>
      <p className={styles.lead}>{t('mfa.enroll.scan.body')}</p>
      {enrollment.qrDataUri ? (
        <img
          className={styles.qr}
          src={enrollment.qrDataUri}
          alt={t('mfa.enroll.scan.qrAlt')}
          width={240}
          height={240}
        />
      ) : (
        <p className={styles.muted}>{t('mfa.enroll.scan.noQr')}</p>
      )}
      <ButtonLink href={enrollment.uri} block onClick={wizard.openApp}>
        {t('mfa.enroll.scan.open')}
      </ButtonLink>
      <div className={styles.key}>
        <span className={styles.muted}>{t('mfa.enroll.scan.key')}</span>
        <span className={styles.keyValue} data-testid="enroll-key">
          {enrollment.secret}
        </span>
      </div>
      <Button variant="secondary" block onClick={wizard.copyKey}>
        {t('mfa.enroll.scan.copy')}
      </Button>
      <p role="status" className={styles.muted}>
        {wizard.copied ? t('mfa.enroll.scan.copied') : ''}
      </p>
      {wizard.message && (
        <p role="alert" className={styles.error}>
          {t(wizard.message)}
        </p>
      )}
      <Button block onClick={wizard.next}>
        {t('mfa.enroll.scan.next')}
      </Button>
    </div>
  )
}
