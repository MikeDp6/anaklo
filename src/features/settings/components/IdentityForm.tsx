import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { formErrorText } from '@/features/staff/components/formErrorText'
import { useIdentityForm } from '../hooks/useIdentityForm'
import { currencyCodes, currencyName, SLUG_MAX, slugInput, timeZoneOptions } from '../identity'
import type { BusinessIdentity } from '../schema'
import { IdentityConfirm } from './IdentityConfirm'
import styles from './screens.module.css'

/**
 * The identity fields and «Συνέχεια» (contract 1.7 §6.9). The slug is lower-cased as typed and
 * shown as the full address; the zone and currency come from the engine's lists plus the stored
 * value. Whether a value is accepted is the server's answer (rule 13).
 */
export function IdentityForm({
  businessId,
  identity,
}: {
  businessId: string
  identity: BusinessIdentity
}) {
  const { t, i18n } = useTranslation('pro')
  const state = useIdentityForm(businessId, identity)
  const { form } = state

  if (state.pending) return <IdentityConfirm state={state} changes={state.pending} />

  const zones = timeZoneOptions(identity.timeZone).map((zone) => ({ value: zone, label: zone }))
  const currencies = currencyCodes(identity.currency).map((code) => {
    const name = currencyName(code, i18n.language)
    return { value: code, label: name ? t('identity.currencyOption', { code, name }) : code }
  })
  const errors = form.formState.errors
  return (
    <form className={styles.stack} onSubmit={(event) => void state.proceed(event)} noValidate>
      <fieldset className={styles.stack} disabled={state.busy}>
        <Controller
          control={form.control}
          name="slug"
          render={({ field }) => (
            <TextField
              label={t('identity.slug')}
              hint={t('identity.slugHint', {
                url: `${window.location.origin}/${field.value.trim()}`,
              })}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              maxLength={SLUG_MAX}
              error={formErrorText(t, errors.slug?.message)}
              name={field.name}
              ref={field.ref}
              value={field.value}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(slugInput(event.target.value))}
            />
          )}
        />
        <SelectField
          label={t('identity.timezone')}
          options={zones}
          error={formErrorText(t, errors.timeZone?.message)}
          {...form.register('timeZone')}
        />
        <SelectField
          label={t('identity.currency')}
          options={currencies}
          error={formErrorText(t, errors.currency?.message)}
          {...form.register('currency')}
        />
      </fieldset>
      {state.noChanges && (
        <p role="status" className={styles.muted}>
          {t('identity.noChanges')}
        </p>
      )}
      {state.saved && (
        <p role="status" className={styles.status}>
          {t(state.saved.changed ? 'identity.saved' : 'identity.noChanges')}
        </p>
      )}
      <Button type="submit" block disabled={state.busy}>
        {t('identity.continue')}
      </Button>
    </form>
  )
}
