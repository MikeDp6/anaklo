import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useReducedMotion } from '@/shared/motion/useReducedMotion'
import { cx } from '@/shared/ui/cx'
import { useEnrollWizard } from '../hooks/useEnrollWizard'
import type { EnrollMode } from '../pendingEnrollment'
import { stepMotionClass } from '../stepMotion'
import { EnrollCodeStep } from './EnrollCodeStep'
import { EnrollDownloadStep } from './EnrollDownloadStep'
import { EnrollScanStep } from './EnrollScanStep'
import styles from './mfa.module.css'

/**
 * The enrolment wizard (contract 1.7 §6.4): «Βήμα N από 3», then one step at a time, entering
 * with E14 (forward from the right, back from the left; reduced motion → no movement). The focus
 * moves to the new step, so a screen reader starts there. Logic in `useEnrollWizard`.
 */
export function EnrollWizard({
  mode,
  userId,
  verifiedCount,
  onDone,
}: {
  mode: EnrollMode
  userId: string
  verifiedCount: number
  onDone: () => void
}) {
  const { t } = useTranslation('pro')
  const wizard = useEnrollWizard({ mode, userId, verifiedCount, onDone })
  const reduced = useReducedMotion()
  const stepRef = useRef<HTMLDivElement>(null)
  const shown = useRef(wizard.step)
  useEffect(() => {
    if (shown.current === wizard.step) return
    shown.current = wizard.step
    stepRef.current?.focus({ preventScroll: true })
  }, [wizard.step])

  if (wizard.resuming) {
    return (
      <p role="status" className={styles.muted}>
        {t('mfa.enroll.download.preparing')}
      </p>
    )
  }

  return (
    <div className={styles.stack}>
      <p className={styles.muted} aria-live="polite">
        {t('mfa.enroll.stepOf', { step: wizard.stepNumber })}
      </p>
      <div
        key={wizard.step}
        ref={stepRef}
        tabIndex={-1}
        data-step={wizard.step}
        className={cx(styles.step, stepMotionClass(wizard.direction, reduced))}
      >
        {wizard.step === 'download' && <EnrollDownloadStep wizard={wizard} />}
        {wizard.step === 'scan' && <EnrollScanStep wizard={wizard} />}
        {wizard.step === 'code' && <EnrollCodeStep wizard={wizard} />}
      </div>
    </div>
  )
}
