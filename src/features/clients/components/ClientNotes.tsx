import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { useAppLocale } from '@/features/calendar/format'
import { toLocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { TextAreaField } from '@/shared/ui/TextAreaField'
import { formatCardDate } from '../format'
import { useNoteForm } from '../hooks/useNoteForm'
import { CLIENT_FORM_ERRORS, MAX_NOTE_LENGTH, type LiveClientCard } from '../schema'
import styles from './clients.module.css'
import { NoteItem } from './NoteItem'

const ERROR_KEYS: readonly string[] = Object.values(CLIENT_FORM_ERRORS)

/**
 * «Σημειώσεις» (contract 1.8 §4.5): a new note on top (any member; the server records who), the
 * notes newest first below. Plain text only, shown as typed. «Η σημείωση αποθηκεύτηκε.» and the
 * empty form come only after the server answered (rule 14).
 */
export function ClientNotes({
  businessId,
  authorId,
  card,
}: {
  businessId: string
  authorId: string
  card: LiveClientCard
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const titleId = useId()
  const note = useNoteForm(businessId, card.clientId, authorId)
  const { add } = note
  const message = note.form.formState.errors.body?.message
  const error = message
    ? ERROR_KEYS.includes(message)
      ? t(message as (typeof CLIENT_FORM_ERRORS)[keyof typeof CLIENT_FORM_ERRORS])
      : t('errors.invalid')
    : null
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.sectionTitle}>
        {t('clients.notes.title')}
      </h2>
      <form className={styles.stack} onSubmit={(event) => void note.submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={note.busy}>
          <TextAreaField
            label={t('clients.notes.body')}
            hint={t('clients.notes.hint')}
            maxLength={MAX_NOTE_LENGTH}
            error={error}
            {...note.form.register('body')}
          />
          {!add.locked && (
            <Button type="submit" variant="secondary">
              {add.pending ? t('clients.notes.saving') : t('clients.notes.save')}
            </Button>
          )}
        </fieldset>
        <SaveFailure
          failure={add.failure}
          locked={add.locked}
          pending={add.pending}
          onRetry={add.retry}
          onClose={add.reset}
        />
        {note.saved && (
          <p role="status" className={styles.status}>
            {t('clients.notes.saved')}
          </p>
        )}
      </form>
      {card.notes.length === 0 ? (
        <p className={styles.muted}>{t('clients.notes.empty')}</p>
      ) : (
        <ul className={styles.items} aria-label={t('clients.notes.list')}>
          {card.notes.map((item) => (
            <li key={item.id}>
              <NoteItem
                businessId={businessId}
                clientId={card.clientId}
                note={item}
                date={formatCardDate(toLocalDate(new Date(item.createdAt), card.timeZone), locale)}
              />
            </li>
          ))}
        </ul>
      )}
      {card.notesTotal > card.notes.length && (
        <p className={styles.meta}>{t('clients.notes.capped')}</p>
      )}
    </section>
  )
}
