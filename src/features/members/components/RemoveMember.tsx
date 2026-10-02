import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import styles from '@/features/settings/components/screens.module.css'
import type { SettingsMutation } from '@/shared/lib/useSettingsMutation'
import { Button } from '@/shared/ui/Button'
import type { Member, RemoveResult } from '../schema'
import { Consequences } from './Consequences'

/**
 * «Αφαίρεση από την επιχείρηση» with one confirmation (`remove_member`, owner + fresh code on the
 * server). The calendar row of a linked professional stays.
 */
export function RemoveMember({
  member,
  mutation,
  disabled,
  onClose,
}: {
  member: Member
  mutation: SettingsMutation<string, RemoveResult>
  /** Another write of the sheet is running. */
  disabled: boolean
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const [confirming, setConfirming] = useState(false)
  const busy = disabled || mutation.pending || mutation.locked

  if (!confirming) {
    return (
      <Button variant="secondary" block disabled={busy} onClick={() => setConfirming(true)}>
        {t('members.remove')}
      </Button>
    )
  }
  return (
    <div className={styles.stack}>
      <p className={styles.status}>{t('members.removeConfirm')}</p>
      <Consequences items={['signOut']} />
      {member.staffName && (
        <p className={styles.muted}>{t('members.removeKeepsStaff', { name: member.staffName })}</p>
      )}
      <SaveFailure
        failure={mutation.failure}
        locked={mutation.locked}
        pending={mutation.pending}
        onRetry={mutation.retry}
        onClose={onClose}
      />
      {!mutation.locked && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => mutation.submit(member.userId)}
          >
            {mutation.pending ? t('members.removing') : t('members.removeYes')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              mutation.reset()
              setConfirming(false)
            }}
          >
            {t('form.cancel')}
          </Button>
        </div>
      )}
    </div>
  )
}
