import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'

/**
 * Seconds until `resendAt`, ticking once a second while it is in the future. The clock starts
 * when the component mounts: the OTP step mounts it once per challenge (`key`), so a resend
 * minutes after the last countdown never counts from a stale time.
 */
function useSecondsUntil(resendAt: string): number {
  const [now, setNow] = useState(() => Date.now())
  const left = Math.max(0, Math.ceil((Date.parse(resendAt) - now) / 1000))
  useEffect(() => {
    if (left <= 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [left])
  return left
}

/** «Στείλε νέο κωδικό», disabled with a countdown until the server allows a new code (AN019). */
export function ResendButton({
  resendAt,
  disabled,
  onResend,
}: {
  resendAt: string
  disabled: boolean
  onResend: () => void
}) {
  const { t } = useTranslation('booking')
  const secondsLeft = useSecondsUntil(resendAt)
  return (
    <Button variant="secondary" disabled={secondsLeft > 0 || disabled} onClick={onResend}>
      {secondsLeft > 0 ? t('otp.resendIn', { seconds: secondsLeft }) : t('otp.resend')}
    </Button>
  )
}
