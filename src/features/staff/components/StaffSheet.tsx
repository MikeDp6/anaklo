import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import { Button } from '@/shared/ui/Button'
import { SwitchField } from '@/shared/ui/SwitchField'
import { TextField } from '@/shared/ui/TextField'
import { firstFreeColor } from '../colors'
import { useCreateStaff, useUpdateStaff } from '../hooks/useStaffMutations'
import {
  nextStaffSort,
  STAFF_NAME_MAX,
  StaffFormSchema,
  toStaffForm,
  toStaffInput,
  type StaffFormValues,
  type StaffMember,
} from '../schema'
import { ColorField } from './ColorField'
import { formErrorText } from './formErrorText'
import styles from './settings.module.css'
import { StaffSaved } from './StaffSaved'

export type StaffSheetTarget =
  | { readonly kind: 'new'; readonly id: string }
  | { readonly kind: 'edit'; readonly member: StaffMember }

/**
 * One staff member (contract 1.6 §4.4): name, colour, active (existing only). A new one is
 * inserted under the id fixed when the sheet opened (`ON CONFLICT DO NOTHING`: the retry of an
 * insert that committed inserts nothing). Success only after the server answered (rule 14).
 */
export function StaffSheet({
  businessId,
  target,
  staff,
  onClose,
}: {
  businessId: string
  target: StaffSheetTarget
  staff: readonly StaffMember[]
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const member = target.kind === 'edit' ? target.member : null
  const create = useCreateStaff(businessId)
  const update = useUpdateStaff(businessId)
  const save = member ? update : create
  const form = useForm<StaffFormValues>({
    resolver: zodResolver(StaffFormSchema),
    defaultValues: toStaffForm(member, firstFreeColor(staff.map((other) => other.color))),
  })
  const active = useWatch({ control: form.control, name: 'active' })
  const busy = save.pending || save.locked
  const title = t(member ? 'staffSettings.sheet.editTitle' : 'staffSettings.sheet.newTitle')
  const close = () => {
    save.reset()
    onClose()
  }

  if (save.succeeded) {
    const id = member?.id ?? (target.kind === 'new' ? target.id : '')
    return (
      <Sheet title={title} onClose={onClose}>
        <StaffSaved
          businessId={businessId}
          staffId={id}
          created={member === null}
          deactivated={member !== null && member.active && update.result?.active === false}
          onDone={onClose}
        />
      </Sheet>
    )
  }

  const submit = form.handleSubmit((values) => {
    if (member) update.submit(toStaffInput(values, member.id, member.sort))
    else if (target.kind === 'new')
      create.submit(toStaffInput(values, target.id, nextStaffSort(staff)))
  })
  return (
    <Sheet title={title} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={busy}>
          <TextField
            label={t('staffSettings.fields.name')}
            hint={t('staffSettings.fields.nameHint')}
            autoComplete="off"
            maxLength={STAFF_NAME_MAX}
            error={formErrorText(t, form.formState.errors.displayName?.message)}
            {...form.register('displayName')}
          />
          <Controller
            control={form.control}
            name="color"
            render={({ field }) => (
              <ColorField
                value={field.value}
                onChange={field.onChange}
                current={member?.color ?? null}
                disabled={busy}
              />
            )}
          />
          {member && (
            <Controller
              control={form.control}
              name="active"
              render={({ field }) => (
                <SwitchField
                  label={t('staffSettings.fields.active')}
                  hint={member.active && !active ? t('staffSettings.fields.deactivateHint') : null}
                  checked={field.value}
                  onChange={field.onChange}
                  disabled={busy}
                />
              )}
            />
          )}
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
