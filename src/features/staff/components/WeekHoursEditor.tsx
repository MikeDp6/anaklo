import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { WEEKDAY_KEYS, type WeekdayKey } from '@fn-shared/hours.ts'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { useReplaceWeekHours } from '../hooks/useWeekHours'
import type { WeekRow } from '../schema'
import {
  copyDayToAll,
  toWeekForm,
  toWeekRows,
  WeekHoursFormSchema,
  type WeekForm,
} from '../weekHours'
import { DayHoursRow } from './DayHoursRow'
import styles from './settings.module.css'

/**
 * One staff member's week (contract 1.6 §4.5): a row per weekday, Monday first, split shifts,
 * «Αντιγραφή σε όλες τις μέρες»; nothing is saved until «Αποθήκευση», which sends the whole week
 * in ONE `replace_week_hours` (overlap → nothing changes). Appointments outside the new hours stay;
 * the answer says how many there are.
 */
export function WeekHoursEditor({
  businessId,
  staffId,
  rows,
}: {
  businessId: string
  staffId: string
  rows: readonly WeekRow[]
}) {
  const { t } = useTranslation('pro')
  const [copied, setCopied] = useState<WeekdayKey | null>(null)
  const form = useForm<WeekForm>({
    resolver: zodResolver(WeekHoursFormSchema),
    defaultValues: toWeekForm(rows),
  })
  // The week as the server answered becomes the form's new starting point (not dirty).
  const save = useReplaceWeekHours(businessId, (saved) => form.reset(toWeekForm(saved.rows)))
  const busy = save.pending || save.locked
  const result = save.result && !form.formState.isDirty ? save.result : null

  const submit = form.handleSubmit((values) => {
    setCopied(null)
    save.submit({ staffId, rows: toWeekRows(values) })
  })
  return (
    <form
      className={styles.stack}
      onSubmit={(event) => void submit(event)}
      noValidate
      onChange={() => setCopied(null)}
    >
      <fieldset className={styles.stack} disabled={busy}>
        {WEEKDAY_KEYS.map((day) => (
          <DayHoursRow
            key={day}
            day={day}
            form={form}
            disabled={busy}
            onCopyToAll={() => {
              form.reset(copyDayToAll(form.getValues(), day), { keepDefaultValues: true })
              setCopied(day)
            }}
          />
        ))}
      </fieldset>
      {copied && (
        <p role="status" className={styles.muted}>
          {t('hours.copied')}
        </p>
      )}
      <SaveFailure
        failure={save.failure?.kind === 'overlap' ? null : save.failure}
        locked={save.locked}
        pending={save.pending}
        onRetry={save.retry}
        onClose={save.reset}
      />
      {save.failure?.kind === 'overlap' && (
        <p role="alert" className={styles.error}>
          {t('hours.errors.overlap')}
        </p>
      )}
      {result && (
        <div className={styles.stack} role="status">
          <p className={styles.rowTitle}>{t('hours.saved')}</p>
          {result.conflictCount > 0 && (
            <div className={cx(styles.warning, styles.stack)}>
              <p>{t('hours.conflicts', { count: result.conflictCount })}</p>
              <Link
                to={`/settings/conflicts?staff=${staffId}`}
                className={cx(styles.linkButton, 'pressable')}
              >
                {t('hours.seeConflicts')}
              </Link>
            </div>
          )}
        </div>
      )}
      {!save.locked && (
        <Button type="submit" block disabled={save.pending}>
          {save.pending ? t('form.saving') : t('form.save')}
        </Button>
      )}
    </form>
  )
}
