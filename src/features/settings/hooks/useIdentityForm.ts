import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import {
  IdentityFormSchema,
  identityChanges,
  toIdentityChange,
  toIdentityForm,
  type FieldChange,
  type IdentityFormValues,
} from '../identity'
import type { IdentityValues } from '../schema'
import { useChangeIdentity } from './useIdentity'

/**
 * State of `IdentityForm` (contract 1.7 §6.9): the fields (React Hook Form), then «Συνέχεια» → a
 * confirmation listing only the changed fields with their consequences → «Επιβεβαίωση αλλαγών»
 * sends them. The form is refilled from what the server stored (its answer), never from what was
 * typed.
 */
export function useIdentityForm(businessId: string, stored: IdentityValues) {
  const form = useForm<IdentityFormValues>({
    resolver: zodResolver(IdentityFormSchema),
    defaultValues: toIdentityForm(stored),
  })
  /** The changes being confirmed; null while editing. */
  const [pending, setPending] = useState<readonly FieldChange[] | null>(null)
  const [noChanges, setNoChanges] = useState(false)
  const change = useChangeIdentity(businessId, (result) => {
    form.reset(toIdentityForm(result.stored))
    setPending(null)
  })

  const proceed = form.handleSubmit((values) => {
    const changes = identityChanges(stored, values)
    setNoChanges(changes.length === 0)
    if (changes.length > 0) {
      change.reset()
      setPending(changes)
    }
  })
  const confirm = () => {
    if (pending) change.submit(toIdentityChange(pending))
  }
  const back = () => {
    change.reset()
    setPending(null)
  }

  return {
    form,
    change,
    /** «Συνέχεια». */
    proceed,
    confirm,
    back,
    pending,
    noChanges: noChanges && pending === null,
    /** «Αποθηκεύτηκε.» (or «Δεν άλλαξε κάτι.») from the server's answer, until the next edit. */
    saved: change.result !== null && !form.formState.isDirty ? change.result : null,
    busy: change.pending || change.locked,
  }
}

export type IdentityFormState = ReturnType<typeof useIdentityForm>
