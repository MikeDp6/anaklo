import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import type { LocalDate } from '@/shared/lib/dates'
import type { TimeOff } from '../schema'
import {
  newTimeOffForm,
  timeOffFormSchema,
  toTimeOffForm,
  toTimeOffRange,
  type TimeOffFormValues,
} from '../timeOffRange'
import { useDeleteTimeOff, useSaveTimeOff } from './useTimeOff'

/** A new time off (its id generated when the sheet opened, D17) or an existing row. */
export type TimeOffTarget =
  | { readonly kind: 'new'; readonly id: string }
  | { readonly kind: 'edit'; readonly timeOff: TimeOff }

/**
 * State of `TimeOffSheet` (contract 1.6 §4.7): React Hook Form with `timeOffFormSchema`, a save
 * (insert with the sheet's id, or update of the row) and, for an existing row, «Διαγραφή». The
 * range is computed in the business zone (`toTimeOffRange`); the database decides overlaps. An
 * existing time off keeps its staff member (the update writes range and reason only): the save
 * always sends the row's own `staffId`, whatever the form holds.
 */
export function useTimeOffForm(
  businessId: string,
  timeZone: string,
  today: LocalDate,
  target: TimeOffTarget,
) {
  const isNew = target.kind === 'new'
  const id = target.kind === 'new' ? target.id : target.timeOff.id
  /** The staff member of an existing row; null for a new one (chosen in the form). */
  const fixedStaffId = target.kind === 'edit' ? target.timeOff.staffId : null
  // The «now» of the check «a new time off ends after now»: fixed while the sheet is open.
  const [now] = useState(() => new Date())
  const schema = useMemo(() => timeOffFormSchema({ timeZone, now, isNew }), [timeZone, now, isNew])
  const form = useForm<TimeOffFormValues>({
    resolver: zodResolver(schema),
    defaultValues:
      target.kind === 'new' ? newTimeOffForm('', today) : toTimeOffForm(target.timeOff, timeZone),
  })
  const allDay = useWatch({ control: form.control, name: 'allDay' })
  const save = useSaveTimeOff(businessId)
  const remove = useDeleteTimeOff(businessId)
  const [submitted, setSubmitted] = useState<TimeOffFormValues | null>(null)

  const submit = form.handleSubmit((values) => {
    setSubmitted(values)
    remove.reset()
    save.submit({
      id,
      staffId: fixedStaffId ?? values.staffId,
      reason: values.reason,
      ...toTimeOffRange(values, timeZone),
      isNew,
    })
  })

  return {
    form,
    allDay,
    save,
    remove,
    submitted,
    submit,
    isNew,
    fixedStaffId,
    deleteRow: () => {
      save.reset()
      remove.submit(id)
    },
    busy: save.pending || save.locked || remove.pending || remove.locked,
  }
}
