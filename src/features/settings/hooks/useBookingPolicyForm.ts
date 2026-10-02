import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import {
  BookingPolicyFormSchema,
  toPolicyForm,
  toPolicyInput,
  type BookingPolicyFormValues,
} from '../policySchema'
import type { BookingPolicy } from '../schema'
import { useUpdateBookingPolicy } from './useBookingPolicy'

/**
 * State of `BookingPolicyForm` (contract 1.6 §4.8): React Hook Form with
 * `BookingPolicyFormSchema`, every field saved in one update; the form is refilled from what the
 * server stored (its answer), never from what was typed.
 */
export function useBookingPolicyForm(businessId: string, policy: BookingPolicy) {
  const form = useForm<BookingPolicyFormValues>({
    resolver: zodResolver(BookingPolicyFormSchema),
    defaultValues: toPolicyForm(policy),
  })
  const update = useUpdateBookingPolicy(businessId, (stored) => form.reset(toPolicyForm(stored)))
  const [bookingEnabled, allowAnyStaff, messagingEnabled] = useWatch({
    control: form.control,
    name: ['bookingEnabled', 'allowAnyStaff', 'messagingEnabled'],
  })
  const submit = form.handleSubmit((values) => update.submit(toPolicyInput(values)))
  const setSwitch =
    (name: 'bookingEnabled' | 'allowAnyStaff' | 'messagingEnabled') => (checked: boolean) =>
      form.setValue(name, checked, { shouldDirty: true })

  return {
    form,
    update,
    submit,
    switches: { bookingEnabled, allowAnyStaff, messagingEnabled },
    setSwitch,
    busy: update.pending || update.locked,
  }
}

export type BookingPolicyFormState = ReturnType<typeof useBookingPolicyForm>
