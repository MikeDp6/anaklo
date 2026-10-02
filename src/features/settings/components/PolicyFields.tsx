import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { REMINDER_MODES } from '@/shared/lib/domain'
import { SelectField } from '@/shared/ui/SelectField'
import { SwitchField } from '@/shared/ui/SwitchField'
import { TextField } from '@/shared/ui/TextField'
import { durationParts } from '../durationParts'
import type { BookingPolicyFormState } from '../hooks/useBookingPolicyForm'
import {
  AUTO_COMPLETE_PRESETS,
  NOTICE_PRESETS,
  POLICY_ERRORS,
  POLICY_RANGES,
  presetOptions,
  SLOT_STEPS,
  type PolicyErrorKey,
} from '../policySchema'
import type { BookingPolicy } from '../schema'
import styles from './screens.module.css'

/** «Καμία», «15 λεπτά», «2 ώρες», «1 μέρα», «1 ώρα 30 λεπτά» (contract 1.6 §4.8). */
function durationLabel(t: TFunction<'pro'>, minutes: number): string {
  const parts = durationParts(minutes)
  if (parts.length === 0) return t('policy.duration.none')
  return parts.map((part) => t(`policy.duration.${part.unit}`, { count: part.count })).join(' ')
}

const ERROR_KEYS: readonly string[] = Object.values(POLICY_ERRORS)

/** The fields of `BookingPolicyForm`, in three sections. */
export function PolicyFields({
  state,
  stored,
}: {
  state: BookingPolicyFormState
  /** What the server has now: a non-preset minute value is offered as an extra option (D18). */
  stored: BookingPolicy
}) {
  const { t } = useTranslation('pro')
  const { form, switches, setSwitch } = state
  const { errors } = form.formState
  const errorText = (field: keyof typeof errors) => {
    const message = errors[field]?.message
    if (!message) return null
    if (!ERROR_KEYS.includes(message)) return t('errors.invalid')
    const range = field in POLICY_RANGES ? POLICY_RANGES[field as keyof typeof POLICY_RANGES] : {}
    return t(message as PolicyErrorKey, { ...range })
  }
  const minutes = (presets: readonly number[], value: number) =>
    presetOptions(presets, value).map((option) => ({
      value: String(option),
      label: durationLabel(t, option),
    }))

  return (
    <>
      <fieldset className={styles.section}>
        <legend className={styles.legend}>{t('policy.sectionBooking')}</legend>
        <SwitchField
          label={t('policy.bookingEnabled')}
          hint={switches.bookingEnabled ? null : t('policy.bookingEnabledOff')}
          checked={switches.bookingEnabled}
          onChange={setSwitch('bookingEnabled')}
        />
        <SelectField
          label={t('policy.slotStep')}
          hint={t('policy.slotStepHint')}
          options={presetOptions(SLOT_STEPS, null).map((step) => ({
            value: String(step),
            label: durationLabel(t, step),
          }))}
          error={errorText('slotStepMin')}
          {...form.register('slotStepMin')}
        />
        <SelectField
          label={t('policy.minNotice')}
          hint={t('policy.minNoticeHint')}
          options={minutes(NOTICE_PRESETS, stored.minNoticeMin)}
          error={errorText('minNoticeMin')}
          {...form.register('minNoticeMin')}
        />
        <TextField
          label={t('policy.maxAdvance')}
          hint={t('policy.maxAdvanceHint')}
          inputMode="numeric"
          autoComplete="off"
          error={errorText('maxAdvanceDays')}
          {...form.register('maxAdvanceDays')}
        />
        <SelectField
          label={t('policy.cancelNotice')}
          hint={t('policy.cancelNoticeHint')}
          options={minutes(NOTICE_PRESETS, stored.cancelMinNoticeMin)}
          error={errorText('cancelMinNoticeMin')}
          {...form.register('cancelMinNoticeMin')}
        />
        <SwitchField
          label={t('policy.allowAnyStaff')}
          hint={t('policy.allowAnyStaffHint')}
          checked={switches.allowAnyStaff}
          onChange={setSwitch('allowAnyStaff')}
        />
      </fieldset>
      <fieldset className={styles.section}>
        <legend className={styles.legend}>{t('policy.sectionAppointments')}</legend>
        <SelectField
          label={t('policy.autoComplete')}
          hint={t('policy.autoCompleteHint')}
          options={minutes(AUTO_COMPLETE_PRESETS, stored.autoCompleteAfterMin)}
          error={errorText('autoCompleteAfterMin')}
          {...form.register('autoCompleteAfterMin')}
        />
        <TextField
          label={t('policy.correctionWindow')}
          hint={t('policy.correctionWindowHint')}
          inputMode="numeric"
          autoComplete="off"
          error={errorText('correctionWindowDays')}
          {...form.register('correctionWindowDays')}
        />
      </fieldset>
      <fieldset className={styles.section}>
        <legend className={styles.legend}>{t('policy.sectionReminders')}</legend>
        <SwitchField
          label={t('policy.messagingEnabled')}
          hint={t('policy.messagingEnabledHint')}
          checked={switches.messagingEnabled}
          onChange={setSwitch('messagingEnabled')}
        />
        <fieldset className={styles.stack}>
          <legend className={styles.legend}>{t('policy.reminderMode')}</legend>
          {REMINDER_MODES.map((mode) => (
            <label key={mode} className={styles.choice}>
              <span className={styles.title}>{t(`policy.reminderModes.${mode}`)}</span>
              <input type="radio" value={mode} {...form.register('reminderMode')} />
            </label>
          ))}
        </fieldset>
        <fieldset className={styles.stack}>
          <legend className={styles.legend}>{t('policy.quietHours')}</legend>
          <p className={styles.muted}>{t('policy.quietHoursHint')}</p>
          <div className={styles.pair}>
            <TextField
              type="time"
              label={t('policy.quietStart')}
              error={errorText('quietStart')}
              {...form.register('quietStart')}
            />
            <TextField
              type="time"
              label={t('policy.quietEnd')}
              error={errorText('quietEnd')}
              {...form.register('quietEnd')}
            />
          </div>
        </fieldset>
        <p className={styles.muted}>{t('policy.replanHint')}</p>
      </fieldset>
    </>
  )
}
