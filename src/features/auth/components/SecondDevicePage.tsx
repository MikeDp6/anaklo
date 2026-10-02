import { useTranslation } from 'react-i18next'
import { useReducedMotion } from '@/shared/motion/useReducedMotion'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { useMfaRoute } from '../hooks/useMfaRoute'
import { useSecondDevice } from '../hooks/useSecondDevice'
import { stepMotionClass } from '../stepMotion'
import { EnrollWizard } from './EnrollWizard'
import styles from './mfa.module.css'
import { MfaFrame } from './MfaFrame'

/**
 * /mfa/second-device, «Πρόσθεσε δεύτερη συσκευή» (contract 1.7 §6.5): always after the first
 * enrolment, and after every sign-in while only one device is verified. Enters with E14, like the
 * wizard it opens. «Αργότερα» stays disabled until the box «Καταλαβαίνω…» is checked.
 */
export function SecondDevicePage() {
  const { t } = useTranslation('pro')
  const { user, verifiedFactors, next } = useMfaRoute()
  const screen = useSecondDevice(user.userId, next)
  const reduced = useReducedMotion()
  return (
    <MfaFrame
      title={t('mfa.secondDevice.title')}
      intro={t('mfa.secondDevice.body')}
      className={stepMotionClass('forward', reduced) ?? undefined}
    >
      {screen.adding ? (
        <div className={cx(styles.stack, stepMotionClass('forward', reduced))}>
          <EnrollWizard
            mode="second"
            userId={user.userId}
            verifiedCount={verifiedFactors.length}
            onDone={screen.done}
          />
        </div>
      ) : (
        <div className={styles.stack}>
          <p className={styles.muted}>{t('mfa.secondDevice.hint')}</p>
          <Button block onClick={screen.addNow}>
            {t('mfa.secondDevice.addNow')}
          </Button>
          <label className={cx(styles.check, 'pressable')}>
            <input
              type="checkbox"
              checked={screen.confirmed}
              onChange={(event) => screen.setConfirmed(event.target.checked)}
            />
            <span>{t('mfa.secondDevice.confirm')}</span>
          </label>
          <Button variant="secondary" block disabled={!screen.confirmed} onClick={screen.later}>
            {t('mfa.secondDevice.later')}
          </Button>
        </div>
      )}
    </MfaFrame>
  )
}
