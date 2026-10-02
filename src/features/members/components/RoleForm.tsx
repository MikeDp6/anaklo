import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import styles from '@/features/settings/components/screens.module.css'
import { MEMBER_ROLES } from '@/shared/lib/domain'
import type { SettingsMutation } from '@/shared/lib/useSettingsMutation'
import { Button } from '@/shared/ui/Button'
import {
  roleChangeConsequences,
  RoleFormSchema,
  type Member,
  type RoleChange,
  type RoleFormValues,
  type SetRoleResult,
} from '../schema'
import { Consequences } from './Consequences'

/**
 * The role radio (Ιδιοκτήτης / Διαχειριστής / Προσωπικό). Choosing another role shows what the
 * change does; «Αποθήκευση» sends it (`set_member_role`, owner + fresh code on the server).
 */
export function RoleForm({
  member,
  mutation,
  disabled,
  onClose,
}: {
  member: Member
  mutation: SettingsMutation<RoleChange, SetRoleResult>
  /** Another write of the sheet is running. */
  disabled: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const form = useForm<RoleFormValues>({
    resolver: zodResolver(RoleFormSchema),
    defaultValues: { role: member.role },
  })
  const role = useWatch({ control: form.control, name: 'role' })
  const consequences = roleChangeConsequences(member.role, role)
  const busy = disabled || mutation.pending || mutation.locked
  const submit = form.handleSubmit((values) =>
    mutation.submit({ userId: member.userId, role: values.role }),
  )

  return (
    <form className={styles.stack} onSubmit={(event) => void submit(event)} noValidate>
      <fieldset className={styles.section} disabled={busy}>
        <legend className={styles.legend}>{t('members.role')}</legend>
        {MEMBER_ROLES.map((option) => (
          <label key={option} className={styles.choice}>
            <span className={styles.title}>{t(`members.roles.${option}`)}</span>
            <input type="radio" value={option} {...form.register('role')} />
          </label>
        ))}
      </fieldset>
      <Consequences items={consequences} />
      <SaveFailure
        failure={mutation.failure}
        locked={mutation.locked}
        pending={mutation.pending}
        onRetry={mutation.retry}
        onClose={onClose}
      />
      {!mutation.locked && (
        <Button type="submit" block disabled={busy || consequences.length === 0}>
          {mutation.pending ? t('form.saving') : t('form.save')}
        </Button>
      )}
    </form>
  )
}
