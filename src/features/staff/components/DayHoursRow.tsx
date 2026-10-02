import { useFieldArray, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { WeekdayKey } from '@fn-shared/hours.ts'
import forms from '@/features/appointments/components/forms.module.css'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import { MAX_INTERVALS_PER_DAY, nextInterval, type WeekForm } from '../weekHours'
import { formErrorText } from './formErrorText'
import styles from './settings.module.css'

/**
 * One weekday of the week-hours editor (contract 1.6 §4.5): «Κλειστό» + «Προσθήκη ωραρίου», or its
 * intervals (from/to time inputs, «Αφαίρεση»), «Προσθήκη διαστήματος» (split shift, at most 4) and
 * «Αντιγραφή σε όλες τις μέρες».
 */
export function DayHoursRow({
  day,
  form,
  disabled,
  onCopyToAll,
}: {
  day: WeekdayKey
  form: UseFormReturn<WeekForm>
  disabled: boolean
  onCopyToAll: () => void
}) {
  const { t } = useTranslation('pro')
  const intervals = useFieldArray({ control: form.control, name: `days.${day}` })
  const errors = form.formState.errors.days?.[day]
  const dayName = t(`hours.weekdays.${day}`)
  const max = { max: MAX_INTERVALS_PER_DAY }
  const add = () => intervals.append(nextInterval(form.getValues(`days.${day}`)))

  return (
    <section className={styles.day} aria-label={dayName}>
      <h2 className={styles.dayTitle}>{dayName}</h2>
      {intervals.fields.length === 0 ? (
        <div className={styles.dayClosed}>
          <p className={styles.muted}>{t('hours.closed')}</p>
          <Button
            variant="secondary"
            onClick={add}
            disabled={disabled}
            aria-label={t('hours.addHoursLabel', { day: dayName })}
          >
            {t('hours.addHours')}
          </Button>
        </div>
      ) : (
        <>
          {intervals.fields.map((field, index) => {
            const label = { day: dayName, index: index + 1 }
            return (
              <div key={field.id} className={styles.interval}>
                <div className={forms.row}>
                  <TextField
                    type="time"
                    label={t('hours.start')}
                    aria-label={t('hours.startLabel', label)}
                    error={formErrorText(t, errors?.[index]?.start?.message, max)}
                    {...form.register(`days.${day}.${index}.start`)}
                  />
                  <TextField
                    type="time"
                    label={t('hours.end')}
                    aria-label={t('hours.endLabel', label)}
                    error={formErrorText(t, errors?.[index]?.end?.message, max)}
                    {...form.register(`days.${day}.${index}.end`)}
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={() => intervals.remove(index)}
                  disabled={disabled}
                  aria-label={t('hours.removeLabel', label)}
                >
                  {t('hours.remove')}
                </Button>
              </div>
            )
          })}
          {errors?.root?.message && (
            <p role="alert" className={styles.error}>
              {formErrorText(t, errors.root.message, max)}
            </p>
          )}
          <div className={styles.links}>
            <Button
              variant="secondary"
              onClick={add}
              disabled={disabled || intervals.fields.length >= MAX_INTERVALS_PER_DAY}
              aria-label={t('hours.addIntervalLabel', { day: dayName })}
            >
              {t('hours.addInterval')}
            </Button>
            <Button
              variant="secondary"
              onClick={onCopyToAll}
              disabled={disabled}
              aria-label={t('hours.copyToAllLabel', { day: dayName })}
            >
              {t('hours.copyToAll')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
