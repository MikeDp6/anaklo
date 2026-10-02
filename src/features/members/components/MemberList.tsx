import { useTranslation } from 'react-i18next'
import styles from '@/features/settings/components/screens.module.css'
import { cx } from '@/shared/ui/cx'
import type { Member } from '../schema'
import own from './members.module.css'

/**
 * The members in the server's order (owner, manager, staff, then email). The caller's own row has
 * no actions in 1.7 (D10): it is plain text, every other row opens `MemberSheet`.
 */
export function MemberList({
  members,
  onOpen,
}: {
  members: readonly Member[]
  onOpen: (member: Member) => void
}) {
  const { t } = useTranslation('pro')
  return (
    <ul className={styles.list} aria-label={t('members.listLabel')}>
      {members.map((member) => (
        <li key={member.userId}>
          {member.isSelf ? (
            <div className={styles.item}>
              <MemberSummary member={member} />
            </div>
          ) : (
            <button
              type="button"
              className={cx(styles.rowButton, 'pressable')}
              onClick={() => onOpen(member)}
            >
              <MemberSummary member={member} />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** Email, role (and «εσύ»), the calendar row it is linked to, «Δεν έχει συνδεθεί ακόμη». */
export function MemberSummary({ member }: { member: Member }) {
  const { t } = useTranslation('pro')
  return (
    <>
      <span className={styles.title}>{member.email ?? t('members.noEmail')}</span>
      <span className={own.titleRow}>
        <span className={styles.meta}>{t(`members.roles.${member.role}`)}</span>
        {member.isSelf && <span className={own.badge}>{t('members.self')}</span>}
      </span>
      {member.staffName && (
        <span className={styles.meta}>{t('members.staffLink', { name: member.staffName })}</span>
      )}
      {!member.signedIn && <span className={styles.meta}>{t('members.neverSignedIn')}</span>}
    </>
  )
}
