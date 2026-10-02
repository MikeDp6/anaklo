import { useTranslation } from 'react-i18next'
import { Sheet } from '@/features/appointments/components/Sheet'
import type { LocalDate } from '@/shared/lib/dates'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { closureErrorText } from '../closureErrorText'
import { MAX_NOTE_LENGTH } from '../closureRows'
import { conflictsPath, spanOfDates } from '../conflictWindow'
import { useClosureForm } from '../hooks/useClosureForm'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { ConflictsNotice } from './ConflictsNotice'
import { FormFailure } from './FormFailure'
import { IntervalsField } from './IntervalsField'
import styles from './screens.module.css'

/**
 * «Νέο κλείσιμο» (contract 1.6 §4.6): for the whole shop or one staff member, «Κλειστό» or
 * «Ειδικό ωράριο» (which replaces the weekly hours of those days, D11), a range of up to 62
 * dates, intervals for special hours, a note for the shop only (D4). Saved in one bulk insert;
 * the success state (only after the answer) shows how many appointments now fall in it.
 */
export function ClosureSheet({
  frame,
  today,
  onClose,
}: {
  frame: SettingsFrame
  today: LocalDate
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const closure = useClosureForm(frame.businessId, today)
  const { form, add, submitted } = closure
  const { errors } = form.formState
  const close = () => {
    add.reset()
    onClose()
  }
  const text = (message: string | undefined) => closureErrorText(t, message)

  if (add.succeeded && submitted) {
    const staffId = submitted.scope === '' ? null : submitted.scope
    return (
      <Sheet title={t('closures.sheetTitle')} onClose={onClose}>
        <div className={styles.done}>
          <p role="status" className={styles.status}>
            {t('closures.saved')}
          </p>
          <ConflictsNotice
            businessId={frame.businessId}
            span={spanOfDates(staffId, submitted.from, submitted.to, frame.business.timeZone)}
            link={conflictsPath({ staff: staffId, from: submitted.from, to: submitted.to })}
            textKey="closures.conflicts"
          />
          <Button block onClick={onClose}>
            {t('sheet.done')}
          </Button>
        </div>
      </Sheet>
    )
  }

  const scopeOptions = [
    { value: '', label: t('closures.wholeShop') },
    ...frame.activeStaff.map((member) => ({ value: member.id, label: member.displayName })),
  ]
  return (
    <Sheet title={t('closures.sheetTitle')} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void closure.submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={closure.busy}>
          <SelectField
            label={t('closures.scope')}
            options={scopeOptions}
            {...form.register('scope', { onChange: closure.prefill })}
          />
          <fieldset className={styles.section}>
            <legend className={styles.legend}>{t('closures.kind')}</legend>
            {(['closed', 'open'] as const).map((kind) => (
              <label key={kind} className={styles.choice}>
                <span className={styles.choiceText}>
                  <span className={styles.title}>
                    {t(kind === 'closed' ? 'closures.kindClosed' : 'closures.kindSpecial')}
                  </span>
                  <span className={styles.muted}>
                    {t(kind === 'closed' ? 'closures.kindClosedHint' : 'closures.kindSpecialHint')}
                  </span>
                </span>
                <input
                  type="radio"
                  value={kind}
                  {...form.register('kind', { onChange: closure.prefill })}
                />
              </label>
            ))}
          </fieldset>
          <div className={styles.pair}>
            <TextField
              type="date"
              label={t('closures.from')}
              min={today}
              error={text(errors.from?.message)}
              {...form.register('from', { onChange: closure.onFromChange })}
            />
            <TextField
              type="date"
              label={t('closures.to')}
              min={today}
              error={text(errors.to?.message)}
              {...form.register('to')}
            />
          </div>
          {closure.kind === 'open' && (
            <IntervalsField
              fields={closure.intervals.fields}
              register={form.register}
              errors={errors.intervals}
              disabled={closure.busy}
              onEdit={closure.markEdited}
              onAdd={closure.addInterval}
              onRemove={closure.removeInterval}
            />
          )}
          {closure.scope === '' && (
            <TextField
              label={t('closures.note')}
              hint={t('closures.noteHint')}
              maxLength={MAX_NOTE_LENGTH}
              autoComplete="off"
              error={text(errors.note?.message)}
              {...form.register('note')}
            />
          )}
        </fieldset>
        <FormFailure
          failure={add.failure}
          locked={add.locked}
          pending={add.pending}
          overlapKey="closures.errors.overlap"
          onRetry={add.retry}
          onClose={close}
        />
        {!add.locked && (
          <Button type="submit" block disabled={add.pending}>
            {add.pending ? t('form.saving') : t('form.save')}
          </Button>
        )}
      </form>
    </Sheet>
  )
}
