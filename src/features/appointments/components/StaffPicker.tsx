import { useTranslation } from 'react-i18next'
import type { StaffMember } from '@/features/staff/schema'
import { cx } from '@/shared/ui/cx'
import styles from './StaffPicker.module.css'

/** Chips of the staff members who can take the service; one is always chosen. */
export function StaffPicker({
  staff,
  selected,
  disabled,
  onSelect,
}: {
  staff: readonly StaffMember[]
  selected: string
  disabled: boolean
  onSelect: (staffId: string) => void
}) {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.chips} role="group" aria-label={t('slots.staff')}>
      {staff.map((member) => (
        <button
          key={member.id}
          type="button"
          className={cx(styles.chip, 'pressable')}
          aria-pressed={member.id === selected}
          disabled={disabled}
          onClick={() => onSelect(member.id)}
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
