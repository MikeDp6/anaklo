import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { OTP_CODE_LENGTH } from '@fn-shared/booking-schemas.ts'
import { formatPhone } from '@/shared/lib/phone'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import type { BookingFlow } from '../../flow/useBookingFlow'
import { StepSection } from '../StepSection'
import { ResendButton } from './ResendButton'
import { SlotTakenPanel } from './SlotTakenPanel'
import { StepError } from './StepError'
import { useBookingActions } from './useBookingActions'
import styles from './later.module.css'

/**
 * Step 5, only on a new device: the 6-digit SMS code. `one-time-code` lets iOS/Android offer the
 * code from the SMS; the form submits by itself at 6 digits. One verification at a time. A new
 * code (resend) rechecks the time: if it was taken meanwhile (AN001), nearby free times are
 * offered here, as on the other steps.
 */
export function OtpStep({ flow }: { flow: BookingFlow }) {
  const { t } = useTranslation('booking')
  const actions = useBookingActions(flow)
  const { state, dispatch, catalogue } = flow
  const [code, setCode] = useState('')
  const [resent, setResent] = useState(false)
  const challenge = state.challenge
  const verifying = state.pending === 'verify'

  const verify = async (value: string) => {
    if (value.length !== OTP_CODE_LENGTH || state.pending !== null) return
    await actions.verify(value)
    setCode('')
  }

  const onChange = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, OTP_CODE_LENGTH)
    setCode(digits)
    if (digits.length === OTP_CODE_LENGTH) void verify(digits)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void verify(code)
  }

  const resend = async () => {
    setResent(false)
    await actions.resend()
    setResent(true)
  }

  return (
    <StepSection
      direction={state.direction}
      eyebrow={t('otp.eyebrow')}
      title={t('otp.title')}
      takeFocus={false}
    >
      <p>{t('otp.sentTo', { phone: challenge ? formatPhone(challenge.phone) : '' })}</p>
      <SlotTakenPanel flow={flow} />
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={t('otp.code')}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          // The keyboard opens with the step: the code is all this step asks for.
          autoFocus
          pattern="[0-9]*"
          maxLength={OTP_CODE_LENGTH}
          value={code}
          readOnly={verifying}
          onChange={(event) => onChange(event.target.value)}
        />
        {state.error && state.error !== 'AN001' && (
          <StepError code={state.error} phone={catalogue.business.phone_e164} />
        )}
        {resent && !state.error && (
          <p className={styles.status} role="status">
            {t('otp.resent')}
          </p>
        )}
        <Button type="submit" liquid block disabled={state.pending !== null} aria-busy={verifying}>
          {verifying ? t('otp.checking') : t('otp.submit')}
        </Button>
      </form>
      <div className={styles.links}>
        {challenge && (
          // One countdown per challenge: a resend starts a fresh one (never a stale clock).
          <ResendButton
            key={challenge.id}
            resendAt={challenge.resendAt}
            disabled={state.pending !== null}
            onResend={() => void resend()}
          />
        )}
        <button
          type="button"
          className={styles.textButton}
          disabled={state.pending !== null}
          onClick={() => dispatch({ type: 'back' })}
        >
          {t('otp.changePhone')}
        </button>
      </div>
    </StepSection>
  )
}
