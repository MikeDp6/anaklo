import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sheet } from '@/features/appointments/components/Sheet'
import { TIME_OFF_REASONS } from '@/shared/lib/domain'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { SwitchField } from '@/shared/ui/SwitchField'
import { TextField } from '@/shared/ui/TextField'
import { timeOffErrorText } from '../closureErrorText'
import { conflictsPath } from '../conflictWindow'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { useTimeOffForm, type TimeOffTarget } from '../hooks/useTimeOffForm'
import { ConfirmDelete } from './ConfirmDelete'
import { ConflictsNotice } from './ConflictsNotice'
import { FormFailure } from './FormFailure'
import styles from './screens.module.css'

/**
 * «Νέα άδεια» / an existing time off (contract 1.6 §4.7): staff member, a neutral reason of the
 * closed list (never anything about health, GDPR art. 9), all day or with times, the dates.
 * Success only after the answer, with the count of appointments that fall in it.
 */
export function TimeOffSheet({
  frame,
  today,
  target,
  onClose,
}: {
  frame: SettingsFrame
  today: string
  target: TimeOffTarget
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const zone = frame.business.timeZone
  const state = useTimeOffForm(frame.businessId, zone, today, target)
  const { form, save, remove, submitted } = state
  const { errors } = form.formState
  const [confirming, setConfirming] = useState(false)
  const title = t(state.isNew ? 'timeOff.sheetNew' : 'timeOff.sheetEdit')
  const text = (message: string | undefined) => timeOffErrorText(t, message)
  const close = () => {
    save.reset()
    remove.reset()
    onClose()
  }

  if ((save.succeeded && submitted) || remove.succeeded) {
    // What was saved: the sent input (the row's own staff member when editing), not the form.
    const sent = save.variables
    return (
      <Sheet title={title} onClose={onClose}>
        <div className={styles.done}>
          <p role="status" className={styles.status}>
            {t(remove.succeeded ? 'timeOff.deleted' : 'timeOff.saved')}
          </p>
          {!remove.succeeded && sent && submitted && (
            <ConflictsNotice
              businessId={frame.businessId}
              span={{ staffId: sent.staffId, from: sent.startsAt, to: sent.endsAt }}
              link={conflictsPath({
                staff: sent.staffId,
                from: submitted.fromDate,
                to: submitted.toDate,
              })}
              textKey="timeOff.conflicts"
            />
          )}
          <Button block onClick={onClose}>
            {t('sheet.done')}
          </Button>
        </div>
      </Sheet>
    )
  }

  const staffOptions = [
    { value: '', label: t('timeOff.chooseStaff') },
    ...frame.activeStaff.map((member) => ({ value: member.id, label: member.displayName })),
  ]
  const failing = remove.failure || remove.locked ? remove : save
  return (
    <Sheet title={title} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void state.submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={state.busy}>
          {state.fixedStaffId === null ? (
            <SelectField
              label={t('timeOff.staff')}
              options={staffOptions}
              error={text(errors.staffId?.message)}
              {...form.register('staffId')}
            />
          ) : (
            // Never moved to another staff member (0008 grants no UPDATE of staff_id).
            <TextField
              label={t('timeOff.staff')}
              hint={t('timeOff.staffFixed')}
              value={frame.staffNames.get(state.fixedStaffId) ?? ''}
              readOnly
            />
          )}
          <fieldset className={styles.section}>
            <legend className={styles.legend}>{t('timeOff.reason')}</legend>
            {TIME_OFF_REASONS.map((reason) => (
              <label key={reason} className={styles.choice}>
                <span className={styles.title}>{t(`timeOff.reasons.${reason}`)}</span>
                <input type="radio" value={reason} {...form.register('reason')} />
              </label>
            ))}
          </fieldset>
          <SwitchField
            label={t('timeOff.allDay')}
            checked={state.allDay}
            disabled={state.busy}
            onChange={(checked) => form.setValue('allDay', checked, { shouldDirty: true })}
          />
          <div className={styles.pair}>
            <TextField
              type="date"
              label={t('timeOff.from')}
              error={text(errors.fromDate?.message)}
              {...form.register('fromDate')}
            />
            {!state.allDay && (
              <TextField
                type="time"
                label={t('timeOff.fromTime')}
                error={text(errors.fromTime?.message)}
                {...form.register('fromTime')}
              />
            )}
          </div>
          <div className={styles.pair}>
            <TextField
              type="date"
              label={t('timeOff.to')}
              error={text(errors.toDate?.message)}
              {...form.register('toDate')}
            />
            {!state.allDay && (
              <TextField
                type="time"
                label={t('timeOff.toTime')}
                error={text(errors.toTime?.message)}
                {...form.register('toTime')}
              />
            )}
          </div>
        </fieldset>
        <FormFailure
          failure={failing.failure}
          locked={failing.locked}
          pending={failing.pending}
          overlapKey="timeOff.errors.overlap"
          onRetry={failing.retry}
          onClose={close}
        />
        {!save.locked && !remove.locked && (
          <Button type="submit" block disabled={state.busy}>
            {save.pending ? t('form.saving') : t('form.save')}
          </Button>
        )}
        {!state.isNew && !save.locked && !remove.locked && (
          <ConfirmDelete
            confirming={confirming}
            busy={state.busy}
            onAsk={() => setConfirming(true)}
            onCancel={() => setConfirming(false)}
            onConfirm={state.deleteRow}
          />
        )}
      </form>
    </Sheet>
  )
}
