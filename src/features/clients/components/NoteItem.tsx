import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { ConfirmDelete } from '@/features/settings/components/ConfirmDelete'
import { useDeleteNote } from '../hooks/useClientMutations'
import type { ClientNote } from '../schema'
import styles from './clients.module.css'

/**
 * One note: its text as typed (never HTML), when and who («Εσύ», the colleague and their role,
 * or «Πρώην μέλος»), and «Διαγραφή» with one confirmation where the server allows it (the
 * author, or the owner: `can_delete`).
 */
export function NoteItem({
  businessId,
  clientId,
  note,
  date,
}: {
  businessId: string
  clientId: string
  note: ClientNote
  /** The note's business-local date, formatted. */
  date: string
}) {
  const { t } = useTranslation('pro')
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteNote(businessId, clientId)
  const author = note.byMe
    ? t('clients.notes.byMe')
    : note.authorRole === null
      ? t('clients.notes.formerMember')
      : [note.authorName, t(`members.roles.${note.authorRole}`)].filter(Boolean).join(' · ')
  return (
    <article className={styles.note}>
      <p className={styles.noteBody}>{note.body}</p>
      <p className={styles.meta}>{[date, author].join(' · ')}</p>
      {note.canDelete && (
        <>
          <ConfirmDelete
            confirming={confirming}
            busy={remove.pending || remove.locked}
            label={t('clients.notes.deleteLabel', { date })}
            question={t('clients.notes.confirmDelete')}
            onAsk={() => setConfirming(true)}
            onCancel={() => {
              remove.reset()
              setConfirming(false)
            }}
            onConfirm={() => remove.submit(note.id)}
          />
          <SaveFailure
            failure={remove.failure}
            locked={remove.locked}
            pending={remove.pending}
            onRetry={remove.retry}
            onClose={() => {
              remove.reset()
              setConfirming(false)
            }}
          />
        </>
      )}
    </article>
  )
}
