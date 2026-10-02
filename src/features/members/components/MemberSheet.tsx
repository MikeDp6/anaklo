import { useTranslation } from 'react-i18next'
import { Sheet } from '@/features/appointments/components/Sheet'
import styles from '@/features/settings/components/screens.module.css'
import { Button } from '@/shared/ui/Button'
import { useRemoveMember, useSetMemberRole } from '../hooks/useMemberMutations'
import type { Member } from '../schema'
import own from './members.module.css'
import { RemoveMember } from './RemoveMember'
import { RoleForm } from './RoleForm'

/**
 * One member (contract 1.7 §6.8): the role, with what a change does written before «Αποθήκευση»,
 * and «Αφαίρεση από την επιχείρηση». Both go through the code sheet when the server asks; the
 * outcome shows only from the server's answer (rule 14).
 */
export function MemberSheet({
  businessId,
  member,
  onClose,
}: {
  businessId: string
  member: Member
  onClose: () => void
}) {
  const { t } = useTranslation('pro')
  const setRole = useSetMemberRole(businessId)
  const remove = useRemoveMember(businessId)
  const title = member.email ?? t('members.noEmail')
  const close = () => {
    setRole.reset()
    remove.reset()
    onClose()
  }

  const done = setRole.result
    ? t(setRole.result.changed ? 'members.roleChanged' : 'members.roleUnchanged')
    : remove.result
      ? t(remove.result.removed ? 'members.removed' : 'members.notMember')
      : null
  if (done) {
    return (
      <Sheet title={title} onClose={onClose}>
        <div className={styles.done}>
          <p role="status" className={styles.status}>
            {done}
          </p>
          <Button block onClick={onClose}>
            {t('sheet.done')}
          </Button>
        </div>
      </Sheet>
    )
  }

  const roleBusy = setRole.pending || setRole.locked
  const removeBusy = remove.pending || remove.locked
  return (
    <Sheet title={title} onClose={close}>
      <div className={styles.stack}>
        <RoleForm member={member} mutation={setRole} disabled={removeBusy} onClose={close} />
        <hr className={own.divider} />
        <RemoveMember member={member} mutation={remove} disabled={roleBusy} onClose={close} />
      </div>
    </Sheet>
  )
}
