import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useRef, useState } from 'react'
import { useFieldArray, useForm, useWatch } from 'react-hook-form'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { nextInterval } from '@/features/staff/weekHours'
import type { LocalDate } from '@/shared/lib/dates'
import {
  closureFormSchema,
  MAX_SPECIAL_INTERVALS,
  prefillIntervals,
  SHOP_DEFAULT_INTERVAL,
  toExceptionRows,
  type ClosureFormValues,
} from '../closureRows'
import { useAddExceptions } from './useExceptions'
import { useWeekHoursLoader } from './useWeekHoursLoader'

/**
 * State of `ClosureSheet` (contract 1.6 §4.6): React Hook Form with `closureFormSchema`, the D11
 * prefill of «Ειδικό ωράριο» (until the user edits the intervals), and ONE bulk insert of the
 * rows. The rows get their ids when the user saves; the retry of an unknown outcome resends the
 * very same rows (`useSettingsMutation` keeps the variables), so nothing is inserted twice.
 */
export function useClosureForm(businessId: string, today: LocalDate) {
  const schema = useMemo(() => closureFormSchema(today), [today])
  const form = useForm<ClosureFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { scope: '', kind: 'closed', from: today, to: today, intervals: [], note: '' },
  })
  const intervals = useFieldArray({ control: form.control, name: 'intervals' })
  const [scope, kind] = useWatch({ control: form.control, name: ['scope', 'kind'] })
  const add = useAddExceptions(businessId)
  const loadWeek = useWeekHoursLoader(businessId)
  const [submitted, setSubmitted] = useState<ClosureFormValues | null>(null)
  /** The user changed an interval: no prefill overwrites it any more. */
  const edited = useRef(false)
  /** Only the latest prefill may land (the hours of an earlier choice can answer later). */
  const prefillRun = useRef(0)

  const prefill = async () => {
    const values = form.getValues()
    if (values.kind !== 'open' || edited.current) return
    const run = ++prefillRun.current
    const week = values.scope === '' ? null : await loadWeek(values.scope)
    if (run !== prefillRun.current || edited.current) return
    const next =
      values.scope === '' ? [{ ...SHOP_DEFAULT_INTERVAL }] : prefillIntervals(week, values.from)
    intervals.replace(next)
  }

  const onFromChange = () => {
    const { from, to } = form.getValues()
    // A later first date carries the last one with it (one tap for a single date).
    if (from && to && to < from) form.setValue('to', from)
    void prefill()
  }

  const submit = form.handleSubmit((values) => {
    setSubmitted(values)
    add.submit(toExceptionRows(values, newIdempotencyKey))
  })

  return {
    form,
    intervals,
    scope,
    kind,
    add,
    submitted,
    submit,
    /** «Ειδικό ωράριο» chosen, scope or first date changed: refill unless edited. */
    prefill: () => void prefill(),
    onFromChange,
    markEdited: () => {
      edited.current = true
    },
    addInterval: () => {
      edited.current = true
      if (intervals.fields.length >= MAX_SPECIAL_INTERVALS) return
      intervals.append(nextInterval(form.getValues('intervals')))
    },
    removeInterval: (index: number) => {
      edited.current = true
      intervals.remove(index)
    },
    busy: add.pending || add.locked,
  }
}
