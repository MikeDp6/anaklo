import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import { LOCALES } from '@/shared/lib/domain'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { useClientEditForm } from '../hooks/useClientEditForm'
import { CLIENT_FORM_ERRORS, type LiveClientCard } from '../schema'
import styles from './clients.module.css'

const ERROR_KEYS: readonly string[] = Object.values(CLIENT_FORM_ERRORS)
type ErrorKey = (typeof CLIENT_FORM_ERRORS)[keyof typeof CLIENT_FORM_ERRORS]

/**
 * «Επεξεργασία στοιχείων» (contract 1.8 §4.7): name, mobile (optional) and the language of the
 * client's messages. «Αποθηκεύτηκε.» only after the server answered (rule 14).
 */
export function ClientEditSheet({
  businessId,
  card,
  onClose,
}: {
  businessId: string
  card: LiveClientCard
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const { form, save, submit, busy } = useClientEditForm(businessId, card)
  const { errors } = form.formState
  const text = (message: string | undefined) =>
    message ? (ERROR_KEYS.includes(message) ? t(message as ErrorKey) : t('errors.invalid')) : null
  const close = () => {
    save.reset()
    onClose()
  }
  const title = t('clients.edit.title')

  if (save.succeeded) {
    return (
      <Sheet title={title} onClose={onClose}>
        <div className={styles.done}>
          <p role="status" className={styles.status}>
            {t('clients.edit.saved')}
          </p>
          <Button block onClick={onClose}>
            {t('sheet.done')}
          </Button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet title={title} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={busy}>
          <TextField
            label={t('clients.edit.fullName')}
            autoComplete="off"
            autoCapitalize="words"
            error={text(errors.fullName?.message)}
            {...form.register('fullName')}
          />
          <TextField
            label={t('clients.edit.phone')}
            hint={t('clients.edit.phoneHint')}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            error={text(errors.phone?.message)}
            {...form.register('phone')}
          />
          <SelectField
            label={t('clients.edit.locale')}
            options={LOCALES.map((locale) => ({
              value: locale,
              label: t(`clients.languages.${locale}`),
            }))}
            {...form.register('locale')}
          />
        </fieldset>
        <SaveFailure
          failure={save.failure}
          locked={save.locked}
          pending={save.pending}
          onRetry={save.retry}
          onClose={close}
        />
        {!save.locked && (
          <Button type="submit" block disabled={busy}>
            {save.pending ? t('clients.edit.saving') : t('clients.edit.save')}
          </Button>
        )}
      </form>
    </Sheet>
  )
}
