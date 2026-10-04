import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { failureOf, rpcFailureMessageKey, type RpcFailureMessageKey } from '@/shared/lib/rpcError'
import {
  authorizeFactorAdd,
  EnrollFailure,
  enrollTotp,
  listUnverifiedFactorIds,
  unenrollUnverified,
  type EnrollFailureReason,
  type TotpEnrollment,
} from '../mfaApi'
import { DeviceNameFormSchema, type DeviceNameFormValues } from '../mfaSchema'
import {
  clearPendingEnrollment,
  readPendingEnrollment,
  savePendingEnrollment,
  type EnrollMode,
} from '../pendingEnrollment'
import type { StepDirection } from '../stepMotion'
import { tabStorage } from '../storage'
import { useStepUp } from './useStepUp'

export const ENROLL_STEPS = ['download', 'scan', 'code'] as const
export type EnrollStep = (typeof ENROLL_STEPS)[number]

export type EnrollMessageKey =
  | 'mfa.errors.nameTaken'
  | 'mfa.errors.rateLimited'
  | 'mfa.errors.offline'
  | 'mfa.errors.unknown'
  | 'mfa.errors.copyFailed'
  | RpcFailureMessageKey

const ENROLL_FAILURE_TEXT: Readonly<Record<EnrollFailureReason, EnrollMessageKey>> = {
  name_taken: 'mfa.errors.nameTaken',
  rate_limited: 'mfa.errors.rateLimited',
  offline: 'mfa.errors.offline',
  unknown: 'mfa.errors.unknown',
}

/** AN034: the server refuses a new device until Nous resets the account (contract 1.9b C3). */
function isEnrolmentBlocked(error: unknown): boolean {
  if (error instanceof EnrollFailure) return false
  const failure = failureOf(error)
  return failure.kind === 'domain' && failure.code === 'AN034'
}

/** Best effort: an abandoned unverified factor is removed again before the next enrolment. */
async function forget(factorId: string | null): Promise<void> {
  if (!factorId) return
  try {
    await unenrollUnverified(factorId)
  } catch {
    // See above.
  }
}

/**
 * The three steps of a new device (plan 1.7 «Εγγραφή», contract 1.7 §6.4), modes `first` (the
 * blocking enrolment), `second` («Πρόσθεσε δεύτερη συσκευή») and `add` (Ρυθμίσεις → Ασφάλεια):
 * 1. app + device name → «Την έχω»;
 * 2. generation: the user's unverified factors are removed, then `authorize_factor_change('add')`
 *    (may open the code sheet: `second`/`add` with a stale code), then `mfa.enroll`; the QR, the
 *    `otpauth://` link and the key (component state only, never stored);
 * 3. the 6-digit code → `onDone` only after GoTrue verified it.
 * A first enrolment the server refuses with AN034 (adding a device is blocked until Nous resets
 * the account, contract 1.9b §4.4) calls `onBlocked` and nothing else: no message, no
 * `mfa.enroll`, no code sheet (AN034 is a domain error, `withStepUp` rethrows it). In the other
 * modes it is the generic domain text (`common:errors.AN034`).
 * The pending enrolment (factor, name, mode, stage; never the secret) survives a reload of the
 * installed app: at the code stage the wizard resumes at step 3, at the QR stage it starts the
 * generation again (the QR cannot be shown twice).
 */
export function useEnrollWizard({
  mode,
  userId,
  verifiedCount,
  onDone,
  onBlocked,
}: {
  mode: EnrollMode
  userId: string
  verifiedCount: number
  onDone: () => void
  /** The first enrolment was refused: adding a device is blocked until Nous resets (AN034). */
  onBlocked?: () => void
}) {
  const { t } = useTranslation(['pro', 'common'])
  const queryClient = useQueryClient()
  const stepUp = useStepUp()
  const [step, setStep] = useState<EnrollStep>('download')
  const [direction, setDirection] = useState<StepDirection>(null)
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [factorId, setFactorId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [message, setMessage] = useState<EnrollMessageKey | null>(null)
  const [copied, setCopied] = useState(false)
  // A pending enrolment of this mode is looked at before step 1 shows (no flash of step 1).
  const [resuming, setResuming] = useState(() => {
    const pending = readPendingEnrollment(tabStorage(), userId, new Date())
    return pending?.mode === mode
  })
  const nameForm = useForm<DeviceNameFormValues>({
    resolver: zodResolver(DeviceNameFormSchema),
    defaultValues: { name: t('mfa.defaultDeviceName', { n: verifiedCount + 1 }) },
  })
  const issuer = t('common:app.name')

  // The step as last rendered, for the async generation (its closure may be older).
  const shownStep = useRef<EnrollStep>(step)
  useEffect(() => {
    shownStep.current = step
  }, [step])

  const go = useCallback((next: EnrollStep, towards: Exclude<StepDirection, null>) => {
    shownStep.current = next
    setDirection(towards)
    setStep(next)
  }, [])

  const generate = useCallback(
    async (name: string) => {
      setGenerating(true)
      setMessage(null)
      setCopied(false)
      try {
        for (const id of await listUnverifiedFactorIds()) await unenrollUnverified(id)
        await stepUp(() => authorizeFactorAdd())
        const created = await enrollTotp(name, issuer)
        savePendingEnrollment(tabStorage(), {
          userId,
          factorId: created.factorId,
          friendlyName: name,
          mode,
          stage: 'scan',
          createdAt: Date.now(),
        })
        setEnrollment(created)
        setFactorId(created.factorId)
        nameForm.setValue('name', name)
        go('scan', 'forward')
      } catch (error) {
        if (mode === 'first' && onBlocked && isEnrolmentBlocked(error)) {
          onBlocked()
          return
        }
        setMessage(
          error instanceof EnrollFailure
            ? ENROLL_FAILURE_TEXT[error.reason]
            : rpcFailureMessageKey(failureOf(error)),
        )
        nameForm.setValue('name', name)
        if (shownStep.current !== 'download') go('download', 'back')
      } finally {
        setGenerating(false)
      }
    },
    [stepUp, issuer, userId, mode, nameForm, go, onBlocked],
  )

  // Resume once per mount (StrictMode runs effects twice: the ref keeps it to one).
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || !resuming) return
    resumed.current = true
    const pending = readPendingEnrollment(tabStorage(), userId, new Date())
    void (async () => {
      try {
        if (!pending || pending.mode !== mode) return
        const stillPending = (await listUnverifiedFactorIds()).includes(pending.factorId)
        if (!stillPending) {
          clearPendingEnrollment(tabStorage())
          return
        }
        nameForm.setValue('name', pending.friendlyName)
        if (pending.stage === 'code') {
          setFactorId(pending.factorId)
          setStep('code')
          return
        }
        await forget(pending.factorId)
        clearPendingEnrollment(tabStorage())
        await generate(pending.friendlyName)
      } catch (error) {
        setMessage(rpcFailureMessageKey(failureOf(error)))
      } finally {
        setResuming(false)
      }
    })()
  }, [resuming, userId, mode, nameForm, generate])

  /** Any way out of step 2 (open the app, copy, «Επόμενο») means the code comes next. */
  const markCodeStage = useCallback(() => {
    const pending = readPendingEnrollment(tabStorage(), userId, new Date())
    if (pending && pending.factorId === factorId && pending.stage === 'scan') {
      savePendingEnrollment(tabStorage(), { ...pending, stage: 'code' })
    }
  }, [userId, factorId])

  const copyKey = useCallback(async () => {
    markCodeStage()
    setMessage(null)
    try {
      if (!enrollment) throw new Error('no key')
      await navigator.clipboard.writeText(enrollment.secret)
      setCopied(true)
    } catch {
      setCopied(false)
      setMessage('mfa.errors.copyFailed')
    }
  }, [enrollment, markCodeStage])

  const verified = useCallback(() => {
    clearPendingEnrollment(tabStorage())
    void queryClient.invalidateQueries({ queryKey: proKeys.mfaFactors(userId) })
    onDone()
  }, [queryClient, userId, onDone])

  const restart = useCallback(async () => {
    const abandoned = factorId
    clearPendingEnrollment(tabStorage())
    setEnrollment(null)
    setFactorId(null)
    setMessage(null)
    setCopied(false)
    go('download', 'back')
    await forget(abandoned)
  }, [factorId, go])

  return {
    step,
    stepNumber: ENROLL_STEPS.indexOf(step) + 1,
    direction,
    resuming,
    generating,
    message,
    copied,
    enrollment,
    factorId,
    nameForm,
    submitName: nameForm.handleSubmit(({ name }) => generate(name)),
    openApp: markCodeStage,
    copyKey: () => void copyKey(),
    next: () => {
      markCodeStage()
      setMessage(null)
      go('code', 'forward')
    },
    backToScan: enrollment ? () => go('scan', 'back') : null,
    restart: () => void restart(),
    verified,
  } as const
}

export type EnrollWizardState = ReturnType<typeof useEnrollWizard>
