import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { Sheet } from '@/features/appointments/components/Sheet'
import styles from '@/features/settings/components/screens.module.css'
import type { StaffMember } from '@/features/staff/schema'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { useInviteMember } from '../hooks/useMemberMutations'
import {
  MAX_EMAIL_LENGTH,
  freeStaff,
  INVITE_DEFAULTS,
  INVITE_ROLES,
  InviteFormSchema,
  toInviteBody,
  type InviteFormValues,
  type Member,
} from '../schema'
import { InviteDone } from './InviteDone'

/**
 * «Πρόσκληση μέλους» (contract 1.7 §6.8): email, role (Διαχειριστής / Προσωπικό, D4) and,
 * optionally, the calendar row the new member is. `invite-member` creates the login (no email is
 * sent) and adds the membership; then the owner sends the text of `InviteDone` themselves.
 */
export function InviteSheet({
  businessId,
  businessName,
  staff,
  members,
  onClose,
}: {
  businessId: string
  businessName: string
  staff: readonly StaffMember[]
  members: readonly Member[]
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const invite = useInviteMember(businessId)
  const form = useForm<InviteFormValues>({
    resolver: zodResolver(InviteFormSchema),
    defaultValues: INVITE_DEFAULTS,
  })
  const busy = invite.pending || invite.locked
  const title = t('members.invite')
  const close = () => {
    invite.reset()
    onClose()
  }

  if (invite.result) {
    return (
      <Sheet title={title} onClose={onClose}>
        <InviteDone result={invite.result} businessName={businessName} onDone={onClose} />
      </Sheet>
    )
  }

  const staffOptions = [
    { value: '', label: t('members.staffNone') },
    ...freeStaff(staff, members).map((row) => ({ value: row.id, label: row.displayName })),
  ]
  const submit = form.handleSubmit((values) => invite.submit(toInviteBody(businessId, values)))
  const emailError = form.formState.errors.email?.message
  return (
    <Sheet title={title} onClose={close}>
      <form className={styles.stack} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.stack} disabled={busy}>
          <TextField
            label={t('members.email')}
            hint={t('members.emailHint')}
            type="email"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_EMAIL_LENGTH}
            error={emailError ? t('members.errors.email') : null}
            {...form.register('email')}
          />
          <fieldset className={styles.section}>
            <legend className={styles.legend}>{t('members.role')}</legend>
            {INVITE_ROLES.map((role) => (
              <label key={role} className={styles.choice}>
                <span className={styles.title}>{t(`members.roles.${role}`)}</span>
                <input type="radio" value={role} {...form.register('role')} />
              </label>
            ))}
          </fieldset>
          <SelectField
            label={t('members.staff')}
            hint={t('members.staffHint')}
            options={staffOptions}
            {...form.register('staffId')}
          />
        </fieldset>
        <SaveFailure
          failure={invite.failure}
          locked={invite.locked}
          pending={invite.pending}
          onRetry={invite.retry}
          onClose={close}
        />
        {!invite.locked && (
          <Button type="submit" block disabled={invite.pending}>
            {invite.pending ? t('members.submitting') : t('members.submit')}
          </Button>
        )}
      </form>
    </Sheet>
  )
}
