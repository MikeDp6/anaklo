import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { cx } from '@/shared/ui/cx'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useSetStaffOrder } from '../hooks/useStaffMutations'
import type { StaffMember } from '../schema'
import { moveDown, moveUp } from '../staffOrder'
import styles from './settings.module.css'

/**
 * Everyone, active and inactive, in the shop's order (contract 1.6 §4.4). «Πάνω» / «Κάτω» send the
 * whole new order (`set_staff_order`); the list moves only once the server answered, and every
 * arrow waits while a reorder is pending.
 */
export function StaffList({
  businessId,
  staff,
  onOpen,
}: {
  businessId: string
  staff: readonly StaffMember[]
  onOpen: (member: StaffMember) => void
}) {
  const { t } = useTranslation('pro')
  const order = useSetStaffOrder(businessId)
  const ids = staff.map((member) => member.id)
  const busy = order.pending || order.locked
  const reorder = (next: string[]) => {
    if (next.join() !== ids.join()) order.submit(next)
  }

  if (staff.length === 0) return <p className={styles.muted}>{t('staffSettings.empty')}</p>
  return (
    <div className={styles.stack}>
      {order.pending && (
        <p role="status" className={styles.muted}>
          {t('staffSettings.orderSaving')}
        </p>
      )}
      <SaveFailure
        failure={order.failure}
        locked={order.locked}
        pending={order.pending}
        onRetry={order.retry}
        onClose={order.reset}
      />
      <ul className={styles.list} data-testid="staff-list">
        {staff.map((member, index) => (
          <li key={member.id} className={styles.staffRow}>
            <button
              type="button"
              className={cx(styles.row, 'pressable')}
              aria-label={t('staffSettings.editLabel', { name: member.displayName })}
              onClick={() => onOpen(member)}
            >
              <span
                className={styles.dot}
                style={member.color ? { '--staff-color': member.color } : undefined}
                aria-hidden="true"
              />
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{member.displayName}</span>
                {!member.active && (
                  <span className={styles.badge}>{t('staffSettings.inactive')}</span>
                )}
              </span>
            </button>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={cx(styles.iconButton, 'pressable')}
                aria-label={t('staffSettings.upLabel', { name: member.displayName })}
                disabled={busy || index === 0}
                onClick={() => reorder(moveUp(ids, member.id))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 15l6-6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                className={cx(styles.iconButton, 'pressable')}
                aria-label={t('staffSettings.downLabel', { name: member.displayName })}
                disabled={busy || index === staff.length - 1}
                onClick={() => reorder(moveDown(ids, member.id))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <Link
                to={`/settings/hours?staff=${member.id}`}
                className={cx(styles.linkButton, 'pressable')}
                aria-label={t('staffSettings.hoursLabel', { name: member.displayName })}
              >
                {t('staffSettings.hours')}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** E17 while the staff load. */
export function StaffListSkeleton() {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.stack} role="status">
      <span className="visually-hidden">{t('staffSettings.loading')}</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} height={112} />
      ))}
    </div>
  )
}
