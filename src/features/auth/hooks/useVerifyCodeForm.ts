import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { stepUpVerify, verifyTotp, type VerifiedFactor, type VerifyOutcome } from '../mfaApi'
import {
  CodeFormSchema,
  verifyErrorKey,
  type CodeFormValues,
  type VerifyErrorKey,
} from '../mfaSchema'

/** `signIn`: the code screen and the enrolment. `stepUp`: the code sheet (also refreshes). */
export type VerifyPurpose = 'signIn' | 'stepUp'

/**
 * A 6-digit code for one device (contract 1.7 §6.4–§6.6): the sign-in code, the code sheet and
 * the last step of the enrolment. With several devices the user picks one (the first listed is
 * preselected); `factorId` fixes it (the device being enrolled). Success only after GoTrue's
 * answer (rule 14); a wrong code empties the field and says so. `stepUp` (the code sheet) also
 * refreshes the session, so the retried action carries the new code's time.
 */
export function useVerifyCodeForm({
  factors,
  factorId,
  purpose,
  onVerified,
}: {
  factors: readonly VerifiedFactor[]
  factorId?: string
  purpose: VerifyPurpose
  onVerified: () => void
}) {
  const verify = purpose === 'stepUp' ? stepUpVerify : verifyTotp
  const form = useForm<CodeFormValues>({
    resolver: zodResolver(CodeFormSchema),
    defaultValues: { factorId: factorId ?? factors[0]?.id ?? '', code: '' },
  })
  const [error, setError] = useState<VerifyErrorKey | null>(null)
  const mutation = useMutation({
    mutationFn: async (values: CodeFormValues): Promise<VerifyOutcome> => {
      try {
        return await verify(values.factorId, values.code)
      } catch {
        return { ok: false, reason: 'unknown' }
      }
    },
  })

  const submit = form.handleSubmit(async (values) => {
    setError(null)
    const outcome = await mutation.mutateAsync(values)
    if (outcome.ok) {
      onVerified()
      return
    }
    setError(verifyErrorKey(outcome.reason))
    if (outcome.reason === 'invalid_code') form.setValue('code', '')
  })

  return {
    form,
    submit,
    error,
    verifying: mutation.isPending,
    /** The device choice is shown only with two or more devices and no fixed one. */
    choosesDevice: factorId === undefined && factors.length >= 2,
  } as const
}
