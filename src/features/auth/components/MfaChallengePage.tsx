import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import { cx } from '@/shared/ui/cx'
import { useMfaRoute } from '../hooks/useMfaRoute'
import { afterCodePath, MFA_LOST_DEVICE_PATH, withNext } from '../loaders'
import styles from './mfa.module.css'
import { MfaFrame } from './MfaFrame'
import { VerifyCodeForm } from './VerifyCodeForm'

/**
 * /mfa/challenge (contract 1.7 §6.5): an enrolled owner or manager after the email code. With two
 * or more devices the user picks one (the first is preselected). Once GoTrue verified the code:
 * «Πρόσθεσε δεύτερη συσκευή» while there is only one device, else `next` or «Σήμερα».
 */
export function MfaChallengePage() {
  const { t } = useTranslation('pro')
  const { verifiedFactors, next } = useMfaRoute()
  const navigate = useNavigate()
  return (
    <MfaFrame title={t('mfa.challenge.title')} intro={t('mfa.challenge.body')}>
      <VerifyCodeForm
        factors={verifiedFactors}
        purpose="signIn"
        onVerified={() =>
          void navigate(afterCodePath(verifiedFactors.length, next), { replace: true })
        }
        submitLabel={t('mfa.challenge.submit')}
        verifyingLabel={t('mfa.challenge.verifying')}
        autoFocus
      >
        <div className={styles.links}>
          <Link to={withNext(MFA_LOST_DEVICE_PATH, next)} className={cx(styles.link, 'pressable')}>
            {t('mfa.challenge.lost')}
          </Link>
        </div>
      </VerifyCodeForm>
    </MfaFrame>
  )
}
