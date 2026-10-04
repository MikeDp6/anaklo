import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useMfaRoute } from '../hooks/useMfaRoute'
import { MFA_BLOCKED_PATH, MFA_SECOND_DEVICE_PATH } from '../loaders'
import { EnrollWizard } from './EnrollWizard'
import { MfaFrame } from './MfaFrame'

/**
 * /mfa/enroll (contract 1.7 §6.4): the blocking first enrolment of an owner or manager. No way
 * into the app until a device is verified (every member route sends them back here); only
 * «Αποσύνδεση». Then always «Πρόσθεσε δεύτερη συσκευή». If the server refuses the device because
 * adding one is blocked until Nous resets the account (AN034, contract 1.9b §4.4; e.g. the block
 * began after this screen opened), «Επικοινώνησε με τη Nous» replaces it.
 */
export function MfaEnrollPage() {
  const { t } = useTranslation('pro')
  const { user, verifiedFactors } = useMfaRoute()
  const navigate = useNavigate()
  return (
    <MfaFrame title={t('mfa.enroll.title')} intro={t('mfa.enroll.intro')}>
      <EnrollWizard
        mode="first"
        userId={user.userId}
        verifiedCount={verifiedFactors.length}
        onDone={() => void navigate(MFA_SECOND_DEVICE_PATH, { replace: true })}
        onBlocked={() => void navigate(MFA_BLOCKED_PATH, { replace: true })}
      />
    </MfaFrame>
  )
}
