import { useWatch, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import forms from '@/features/appointments/components/forms.module.css'
import { formErrorText } from '@/features/staff/components/formErrorText'
import styles from '@/features/staff/components/settings.module.css'
import type { StaffMember } from '@/features/staff/schema'
import { TextField } from '@/shared/ui/TextField'
import { SERVICE_LIMITS, type ServiceFormValues } from '../schema'

/**
 * «Ποιοι την κάνουν» (contract 1.6 §4.3): one row per form entry `offers[i]`, labelled with the
 * staff member of THAT entry (`offers[i].staffId`), a checkbox and, when checked, «Δική του
 * διάρκεια» / «Δική του τιμή» (empty = the service's). The entries are fixed when the sheet opens
 * and each row is found by its entry's staff id, so a staff list that changes meanwhile (reordered,
 * someone added or deactivated on another device) never changes which checkbox belongs to whom.
 * Nobody checked → a warning; saving is still allowed.
 */
export function ServiceOffersField({
  form,
  staff,
  disabled,
}: {
  form: UseFormReturn<ServiceFormValues>
  /** The names (by id); the rows follow the form's entries, not this list's order. */
  staff: readonly StaffMember[]
  disabled: boolean
}) {
  const { t } = useTranslation('pro')
  const offers = useWatch({ control: form.control, name: 'offers' })
  const errors = form.formState.errors.offers
  const nobody = offers.every((offer) => !offer.checked)
  const byId = new Map(staff.map((member) => [member.id, member]))

  return (
    <fieldset className={forms.fieldset} disabled={disabled}>
      <legend className={forms.legend}>{t('services.offers.title')}</legend>
      {offers.map((offer, index) => {
        const member = byId.get(offer.staffId)
        if (!member) return null
        const checked = offer.checked
        const rowErrors = errors?.[index]
        return (
          <div key={offer.staffId} className={styles.stack}>
            <label className={forms.toggle}>
              <input type="checkbox" {...form.register(`offers.${index}.checked`)} />
              <span className={forms.toggleText}>
                <span>{member.displayName}</span>
                {!member.active && (
                  <span className={styles.muted}>{t('services.offers.inactive')}</span>
                )}
              </span>
            </label>
            {checked && (
              <div className={forms.row}>
                <TextField
                  label={t('services.offers.customDuration')}
                  aria-label={t('services.offers.customDurationLabel', {
                    name: member.displayName,
                  })}
                  hint={t('services.offers.customHint')}
                  inputMode="numeric"
                  error={formErrorText(
                    t,
                    rowErrors?.customDurationMin?.message,
                    SERVICE_LIMITS.durationMin,
                  )}
                  {...form.register(`offers.${index}.customDurationMin`)}
                />
                <TextField
                  label={t('services.offers.customPrice')}
                  aria-label={t('services.offers.customPriceLabel', { name: member.displayName })}
                  hint={t('services.offers.customHint')}
                  inputMode="decimal"
                  autoComplete="off"
                  error={formErrorText(t, rowErrors?.customPriceCents?.message)}
                  {...form.register(`offers.${index}.customPriceCents`)}
                />
              </div>
            )}
          </div>
        )
      })}
      {nobody && (
        <p className={styles.warning} role="status">
          {t('services.offers.none')}
        </p>
      )}
    </fieldset>
  )
}
