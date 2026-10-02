import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import { formatPrice, useAppLocale } from '@/features/calendar/format'
import styles from '@/features/staff/components/settings.module.css'
import type { StaffMember } from '@/features/staff/schema'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { SwitchField } from '@/shared/ui/SwitchField'
import { TextField } from '@/shared/ui/TextField'
import { useSaveService } from '../hooks/useSaveService'
import {
  SERVICE_LIMITS,
  ServiceFormSchema,
  toSaveServiceInput,
  type CatalogueService,
  type Category,
  type ServiceFormValues,
} from '../schema'
import { offerStaff, toServiceForm } from '../serviceForm'
import { formErrorText } from '@/features/staff/components/formErrorText'
import { ServiceOffersField } from './ServiceOffersField'

export type ServiceSheetTarget =
  | { readonly kind: 'new'; readonly id: string }
  | { readonly kind: 'edit'; readonly service: CatalogueService }

/**
 * One service (contract 1.6 §4.3): React Hook Form + zodResolver, saved with ONE `save_service`
 * call under the id fixed when the sheet opened (a retry after «χωρίς σύνδεση» sends the same id
 * and payload). The success state shows only after the server answered (rule 14).
 */
export function ServiceSheet({
  businessId,
  target,
  categories,
  staff,
  currency,
  onClose,
}: {
  businessId: string
  target: ServiceSheetTarget
  categories: readonly Category[]
  staff: readonly StaffMember[]
  currency: string
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const service = target.kind === 'edit' ? target.service : null
  const id = target.kind === 'edit' ? target.service.id : target.id
  const save = useSaveService(businessId)
  // «Ποιοι την κάνουν» as it was when the sheet opened: the form's entries are built from it, and a
  // refetched staff list (another device) must not shift which row is whose.
  const [offerMembers] = useState(() => offerStaff(service, staff))
  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(ServiceFormSchema),
    defaultValues: toServiceForm(service, offerMembers, locale),
  })
  const { errors } = form.formState
  const busy = save.pending || save.locked
  const title = t(service ? 'services.sheet.editTitle' : 'services.sheet.newTitle')
  const close = () => {
    save.reset()
    onClose()
  }

  const saved = save.result
  if (saved) {
    return (
      <Sheet title={title} onClose={onClose}>
        <div className={styles.stack}>
          <p role="status" className={styles.rowTitle}>
            {t('services.saved')}
          </p>
          <p>
            {t('services.savedSummary', {
              name: saved.name,
              min: saved.durationMin,
              price: formatPrice(saved.priceCents, currency, locale),
            })}
          </p>
          <Button block onClick={onClose}>
            {t('sheet.done')}
          </Button>
        </div>
      </Sheet>
    )
  }

  const submit = form.handleSubmit((values) => save.submit(toSaveServiceInput(values, id)))
  const categoryOptions = [
    ...categories.map((category) => ({ value: category.id, label: category.name })),
    { value: '', label: t('services.noCategory') },
  ]
  return (
    <Sheet title={title} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={busy}>
          <TextField
            label={t('services.fields.name')}
            autoComplete="off"
            maxLength={SERVICE_LIMITS.nameMax}
            error={formErrorText(t, errors.name?.message)}
            {...form.register('name')}
          />
          <SelectField
            label={t('services.fields.category')}
            options={categoryOptions}
            {...form.register('categoryId')}
          />
          <TextField
            label={t('services.fields.duration')}
            inputMode="numeric"
            error={formErrorText(t, errors.durationMin?.message, SERVICE_LIMITS.durationMin)}
            {...form.register('durationMin')}
          />
          <TextField
            label={t('services.fields.buffer')}
            hint={t('services.fields.bufferHint')}
            inputMode="numeric"
            error={formErrorText(t, errors.bufferAfterMin?.message, SERVICE_LIMITS.bufferAfterMin)}
            {...form.register('bufferAfterMin')}
          />
          <TextField
            label={t('services.fields.price')}
            hint={t('services.fields.priceHint')}
            inputMode="decimal"
            autoComplete="off"
            error={formErrorText(t, errors.priceCents?.message)}
            {...form.register('priceCents')}
          />
          <Controller
            control={form.control}
            name="onlineBookable"
            render={({ field }) => (
              <SwitchField
                label={t('services.fields.onlineBookable')}
                hint={t('services.fields.onlineBookableHint')}
                checked={field.value}
                onChange={field.onChange}
                disabled={busy}
              />
            )}
          />
          {service && (
            <Controller
              control={form.control}
              name="active"
              render={({ field }) => (
                <SwitchField
                  label={t('services.fields.active')}
                  hint={t('services.fields.activeHint')}
                  checked={field.value}
                  onChange={field.onChange}
                  disabled={busy}
                />
              )}
            />
          )}
          <ServiceOffersField form={form} staff={offerMembers} disabled={busy} />
        </fieldset>
        <SaveFailure
          failure={save.failure}
          locked={save.locked}
          pending={save.pending}
          onRetry={save.retry}
          onClose={close}
        />
        {!save.locked && (
          <Button type="submit" block disabled={save.pending}>
            {save.pending ? t('form.saving') : t('form.save')}
          </Button>
        )}
      </form>
    </Sheet>
  )
}
