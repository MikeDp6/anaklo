import { useTranslation } from 'react-i18next'
import type { StaffMember } from '@/features/staff/schema'
import { Button } from '@/shared/ui/Button'

/**
 * «Walk-in» for one staff member. The page opens the walk-in sheet (its ActiveSheet), so the
 * sheet never lives inside a part of the screen that a refetch can unmount.
 */
export function WalkInButton({
  staff,
  compact = false,
  onOpen,
}: {
  staff: StaffMember
  /** In a day column header: the staff name is already there. */
  compact?: boolean
  onOpen: (staffId: string) => void
}) {
  const { t } = useTranslation('pro')
  const label = t('walkIn.for', { name: staff.displayName })
  return (
    <Button
      variant="secondary"
      onClick={() => onOpen(staff.id)}
      aria-label={compact ? label : undefined}
    >
      {compact ? t('walkIn.short') : label}
    </Button>
  )
}
