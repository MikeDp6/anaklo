import { useTranslation } from 'react-i18next'
import type { StaffMember } from '@/features/staff/schema'
import { cx } from '@/shared/ui/cx'
import styles from './StaffChips.module.css'

/** Which staff columns the day shows (up to two on a phone). */
export function StaffChips({
  staff,
  selected,
  onToggle,
}: {
  staff: readonly StaffMember[]
  selected: readonly string[]
  onToggle: (staffId: string) => void
}) {
  const { t } = useTranslation('pro')
  if (staff.length <= 1) return null
  return (
    <div className={styles.chips} role="group" aria-label={t('day.columns')}>
      {staff.map((member) => (
        <button
          key={member.id}
          type="button"
          className={cx(styles.chip, 'pressable')}
          aria-pressed={selected.includes(member.id)}
          onClick={() => onToggle(member.id)}
        >
          <span
            className={styles.dot}
            style={{ '--staff-color': member.color ?? undefined }}
            aria-hidden="true"
          />
          {member.displayName}
        </button>
      ))}
    </div>
  )
}
