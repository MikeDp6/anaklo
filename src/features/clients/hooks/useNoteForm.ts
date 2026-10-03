import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { NoteForm, type NoteFormValues } from '../schema'
import { useAddNote } from './useClientMutations'

/**
 * «Νέα σημείωση» (contract 1.8 §4.5): React Hook Form with `NoteForm`; the note's id is made at
 * submit and travels with the attempt, so the identical retry after an unknown outcome inserts
 * nothing twice. The form empties only once the server answered.
 */
export function useNoteForm(
  businessId: string,
  clientId: string,
  authorId: string,
  newId: () => string = newIdempotencyKey,
) {
  const form = useForm<NoteFormValues>({
    resolver: zodResolver(NoteForm),
    defaultValues: { body: '' },
  })
  const add = useAddNote(businessId, clientId, () => form.reset({ body: '' }))
  const submit = form.handleSubmit((values) => {
    add.submit({ id: newId(), clientId, authorId, body: values.body.trim() })
  })
  return {
    form,
    add,
    submit,
    busy: add.pending || add.locked,
    /** «Η σημείωση αποθηκεύτηκε.» until the next note is being typed. */
    saved: add.succeeded && !form.formState.isDirty,
  }
}
