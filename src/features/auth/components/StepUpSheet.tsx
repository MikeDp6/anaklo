import { useTranslation } from 'react-i18next'
import { Sheet } from '@/features/appointments/components/Sheet'
import { Button } from '@/shared/ui/Button'
import type { VerifiedFactor } from '../mfaApi'
import styles from './mfa.module.css'
import { VerifyCodeForm } from './VerifyCodeForm'

/**
 * «Επιβεβαίωση με κωδικό» (contract 1.7 §6.6, plan 1.7 «Frontend»): opened only by a server
 * answer with a step-up hint. A verified code closes it with `true` (the action then runs once
 * more); a wrong code stays here with the reason (a new attempt is a new verification, not a new
 * try of the action); «Άκυρο», Esc or ✕ close it with `false`.
 */
export function StepUpSheet({
  factors,
  onVerified,
  onCancel,
}: {
  factors: readonly VerifiedFactor[]
  onVerified: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('pro')
  return (
    <Sheet title={t('stepUp.title')} onClose={onCancel}>
      <div className={styles.stack}>
        <p className={styles.lead}>{t('stepUp.body')}</p>
        <VerifyCodeForm
          factors={factors}
          purpose="stepUp"
          onVerified={onVerified}
          submitLabel={t('stepUp.submit')}
          verifyingLabel={t('stepUp.verifying')}
          autoFocus
        >
          <Button variant="secondary" block onClick={onCancel}>
            {t('stepUp.cancel')}
          </Button>
        </VerifyCodeForm>
      </div>
    </Sheet>
  )
}
