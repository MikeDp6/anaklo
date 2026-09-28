import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { HOME_PATH } from '../loaders'
import type { LoginMessageKey } from '../loginErrors'
import { LoginCode, LoginEmail, normaliseCode, normaliseEmail } from '../schema'
import {
  confirmLoginCode,
  forgetPendingEmail,
  loadPendingEmail,
  requestLoginCode,
} from '../session'

type Step = { name: 'email' } | { name: 'code'; email: string }

export type LoginFormError = 'pro.login.emailInvalid' | 'pro.login.codeInvalidFormat'

/**
 * Email → 6-digit code (ADR-0009 §1). A pending email (iOS closed the app while the user was in
 * Mail) opens straight on the code step.
 */
export function useLoginFlow() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>(() => {
    const email = loadPendingEmail()
    return email ? { name: 'code', email } : { name: 'email' }
  })
  const [message, setMessage] = useState<LoginMessageKey | null>(() =>
    step.name === 'code' ? 'pro.login.codeSentNeutral' : null,
  )
  const [formError, setFormError] = useState<LoginFormError | null>(null)

  const sendCode = useMutation({
    mutationFn: requestLoginCode,
    onSuccess: (result, email) => {
      setMessage(result.messageKey)
      if (result.codeStep) setStep({ name: 'code', email })
    },
  })

  const verifyCode = useMutation({
    mutationFn: ({ email, code }: { email: string; code: string }) => confirmLoginCode(email, code),
    onSuccess: (result) => {
      if (result.signedIn) void navigate(HOME_PATH, { replace: true })
      else setMessage(result.messageKey)
    },
  })

  function submitEmail(input: string): void {
    const email = normaliseEmail(input)
    if (!LoginEmail.safeParse(email).success) {
      setFormError('pro.login.emailInvalid')
      return
    }
    setFormError(null)
    setMessage(null)
    sendCode.mutate(email)
  }

  function submitCode(input: string): void {
    if (step.name !== 'code') return
    const code = normaliseCode(input)
    if (!LoginCode.safeParse(code).success) {
      setFormError('pro.login.codeInvalidFormat')
      return
    }
    setFormError(null)
    verifyCode.mutate({ email: step.email, code })
  }

  function resendCode(): void {
    if (step.name !== 'code') return
    setFormError(null)
    sendCode.mutate(step.email)
  }

  function changeEmail(): void {
    forgetPendingEmail()
    setFormError(null)
    setMessage(null)
    setStep({ name: 'email' })
  }

  return {
    step,
    message,
    formError,
    sending: sendCode.isPending,
    verifying: verifyCode.isPending,
    submitEmail,
    submitCode,
    resendCode,
    changeEmail,
  } as const
}
