import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { Service } from '@/features/services/schema'
import { toLocalDate, type LocalDate } from '@/shared/lib/dates'
import { useAttemptKey } from '../attemptKey'
import { d8FlagOf, NO_D8_FLAGS, withD8Flag, type D8Flag, type D8Flags } from '../rules'
import {
  EMPTY_QUICK_ADD,
  isClientStepValid,
  QuickAddForm,
  quickAddPayload,
  type QuickAddValues,
} from '../quickAddSchema'
import { useBookAction } from './useAppointmentActions'

export const QUICK_ADD_STEPS = ['client', 'service', 'time'] as const
export type QuickAddStep = (typeof QUICK_ADD_STEPS)[number]

export interface QuickAddPreset {
  readonly staffId?: string
  /** A gap of «Σήμερα»: the time is preselected. */
  readonly startsAt?: string
  /** The day on screen (day view): the free times of that day show first. */
  readonly date?: LocalDate
}

/** Who takes a service by default: the preset, then the member's own staff row, then the first. */
export function defaultStaffFor(
  service: Service | undefined,
  workspace: Pick<Workspace, 'activeStaff' | 'membership'>,
  preferred: string | undefined,
): string {
  const offering = workspace.activeStaff.filter(
    (member) => !service || service.offers.some((offer) => offer.staffId === member.id),
  )
  const pick =
    offering.find((member) => member.id === preferred) ??
    offering.find((member) => member.id === workspace.membership.staffId) ??
    offering[0]
  return pick?.id ?? ''
}

/**
 * State of the quick add (phone booking in < 10″): client → service → staff + time, then ONE call
 * to `staff_book_appointment`. React Hook Form holds the values (zodResolver + zod/mini); the
 * attempt key follows the exact payload (contract 1.4 §2.6.6).
 */
export function useQuickAddFlow(workspace: Workspace, today: LocalDate, preset: QuickAddPreset) {
  const { business } = workspace
  const [step, setStep] = useState<QuickAddStep>('client')
  const [direction, setDirection] = useState<'forward' | 'back' | null>(null)
  const [date, setDate] = useState<LocalDate>(() =>
    preset.startsAt
      ? toLocalDate(new Date(preset.startsAt), business.timeZone)
      : preset.date && preset.date > today
        ? preset.date
        : today,
  )
  const [flags, setFlags] = useState<D8Flags>(NO_D8_FLAGS)
  const keyFor = useAttemptKey()
  const book = useBookAction({ businessId: workspace.businessId, timeZone: business.timeZone })

  const form = useForm<QuickAddValues>({
    resolver: zodResolver(QuickAddForm),
    defaultValues: {
      ...EMPTY_QUICK_ADD,
      staffId: defaultStaffFor(undefined, workspace, preset.staffId),
      startsAt: preset.startsAt ?? '',
    },
  })
  const [clientMode, clientId, clientName, phone, serviceId, staffId, startsAt] = useWatch({
    control: form.control,
    name: ['clientMode', 'clientId', 'clientName', 'phone', 'serviceId', 'staffId', 'startsAt'],
  })
  const values: QuickAddValues = {
    clientMode,
    clientId,
    clientName,
    phone,
    serviceId,
    staffId,
    startsAt,
  }
  const service = workspace.services.find((candidate) => candidate.id === serviceId)
  const busy = book.pending || book.locked

  const go = (next: QuickAddStep) => {
    const forward = QUICK_ADD_STEPS.indexOf(next) > QUICK_ADD_STEPS.indexOf(step)
    setDirection(forward ? 'forward' : 'back')
    setStep(next)
    if (!book.locked) book.reset()
  }

  const send = (valid: QuickAddValues, withFlags: D8Flags) => {
    const payload = quickAddPayload(valid, { locale: business.locale, ...withFlags })
    book.submit({ ...payload, idempotencyKey: keyFor(payload) })
  }

  const submit = form.handleSubmit((valid) => send(valid, flags))

  const d8 = book.failure?.kind === 'domain' ? d8FlagOf(book.failure.code) : null
  const confirmD8 = (flag: D8Flag) => {
    const next = withD8Flag(flags, flag)
    setFlags(next)
    void form.handleSubmit((valid) => send(valid, next))()
  }

  return {
    form,
    values,
    service,
    step,
    direction,
    date,
    busy,
    book,
    d8,
    /** Another day of the strip: the time chosen (or preset by a gap) was of the previous one. */
    setDate: (next: LocalDate) => {
      if (next === date) return
      setDate(next)
      form.setValue('startsAt', '')
      setFlags(NO_D8_FLAGS)
      if (!book.locked) book.reset()
    },
    submit,
    confirmD8,
    back: () => go(step === 'time' ? 'service' : 'client'),
    pickClient: (hit: { id: string; fullName: string }) => {
      form.setValue('clientMode', 'existing')
      form.setValue('clientId', hit.id)
      form.setValue('clientName', hit.fullName)
      go('service')
    },
    startNewClient: (typed: string) => {
      const digits = /^[\d\s+()./-]+$/.test(typed.trim())
      form.setValue('clientMode', 'new')
      form.setValue('clientId', null)
      form.setValue('clientName', digits ? '' : typed.trim())
      form.setValue('phone', digits ? typed.trim() : '')
    },
    backToSearch: () => {
      form.setValue('clientMode', 'existing')
      form.clearErrors()
    },
    confirmNewClient: async () => {
      if (isClientStepValid(form.getValues())) go('service')
      else await form.trigger(['clientName', 'phone'])
    },
    pickService: (id: string) => {
      const picked = workspace.services.find((candidate) => candidate.id === id)
      form.setValue('serviceId', id)
      form.setValue('staffId', defaultStaffFor(picked, workspace, form.getValues('staffId')))
      if (!preset.startsAt) form.setValue('startsAt', '')
      setFlags(NO_D8_FLAGS)
      go('time')
    },
    pickStaff: (id: string) => {
      form.setValue('staffId', id)
      form.setValue('startsAt', '')
      setFlags(NO_D8_FLAGS)
      if (!book.locked) book.reset()
    },
    pickTime: (instant: string) => {
      form.setValue('startsAt', instant, { shouldValidate: false })
      form.clearErrors('startsAt')
      setFlags(NO_D8_FLAGS)
      if (!book.locked) book.reset()
    },
  }
}

export type QuickAddFlow = ReturnType<typeof useQuickAddFlow>
