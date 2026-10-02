import { useTranslation } from 'react-i18next'
import type { FieldArrayWithId, FieldErrors, UseFormRegister } from 'react-hook-form'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import { closureErrorText } from '../closureErrorText'
import { MAX_SPECIAL_INTERVALS, type ClosureFormValues } from '../closureRows'
import styles from './screens.module.css'

/**
 * The intervals of «Ειδικό ωράριο» (1–4 per date, split shift allowed): start and end time inputs
 * (native picker, `HH:MM`; each named with its interval number, «Διάστημα 2: έναρξη», so a screen
 * reader tells them apart), «Αφαίρεση» per interval and «Προσθήκη διαστήματος».
 */
export function IntervalsField({
  fields,
  register,
  errors,
  disabled,
  onEdit,
  onAdd,
  onRemove,
}: {
  fields: readonly FieldArrayWithId<ClosureFormValues, 'intervals'>[]
  register: UseFormRegister<ClosureFormValues>
  errors: FieldErrors<ClosureFormValues>['intervals']
  disabled: boolean
  onEdit: () => void
  onAdd: () => void
  onRemove: (index: number) => void
}) {
  const { t } = useTranslation('pro')
  const listError = closureErrorText(t, errors?.root?.message ?? errors?.message)
  return (
    <fieldset className={styles.section}>
      <legend className={styles.legend}>{t('closures.intervals')}</legend>
      {fields.map((field, index) => (
        <div key={field.id} className={styles.interval}>
          <TextField
            type="time"
            label={t('closures.start')}
            aria-label={t('closures.startLabel', { number: index + 1 })}
            error={closureErrorText(t, errors?.[index]?.start?.message)}
            {...register(`intervals.${index}.start`, { onChange: onEdit })}
          />
          <TextField
            type="time"
            label={t('closures.end')}
            aria-label={t('closures.endLabel', { number: index + 1 })}
            error={closureErrorText(t, errors?.[index]?.end?.message)}
            {...register(`intervals.${index}.end`, { onChange: onEdit })}
          />
          <Button
            variant="secondary"
            onClick={() => onRemove(index)}
            disabled={disabled}
            aria-label={t('closures.removeInterval', { number: index + 1 })}
          >
            {t('closures.remove')}
          </Button>
        </div>
      ))}
      {listError && (
        <p role="alert" className={styles.error}>
          {listError}
        </p>
      )}
      {fields.length < MAX_SPECIAL_INTERVALS && (
        <Button variant="secondary" onClick={onAdd} disabled={disabled}>
          {t('closures.addInterval')}
        </Button>
      )}
    </fieldset>
  )
}
