import type { Workspace } from '@/features/calendar/hooks/useWorkspace'
import type { LocalDate } from '@/shared/lib/dates'
import type { QuickAddPreset } from '../hooks/useQuickAddFlow'
import { AppointmentSheet, type AppointmentTarget } from './AppointmentSheet'
import { QuickAddSheet } from './QuickAddSheet'
import { WalkInSheet } from './WalkInSheet'

export type OpenSheet =
  | { readonly kind: 'quickAdd'; readonly preset?: QuickAddPreset }
  | { readonly kind: 'appointment'; readonly target: AppointmentTarget }
  | { readonly kind: 'walkIn'; readonly staffId: string }

/**
 * The one sheet a day screen has open, if any. It lives at the page level, outside the parts
 * that load (grid, «Σήμερα» lists), so a refetch of those never unmounts an open sheet or its
 * locked retry.
 */
export function ActiveSheet({
  sheet,
  workspace,
  today,
  onClose,
}: {
  sheet: OpenSheet | null
  workspace: Workspace
  today: LocalDate
  onClose: () => void
}) {
  if (!sheet) return null
  switch (sheet.kind) {
    case 'quickAdd':
      return (
        <QuickAddSheet
          workspace={workspace}
          today={today}
          preset={sheet.preset}
          onClose={onClose}
        />
      )
    case 'walkIn':
      return (
        <WalkInSheet
          key={sheet.staffId}
          workspace={workspace}
          staffId={sheet.staffId}
          onClose={onClose}
        />
      )
    case 'appointment':
      return (
        <AppointmentSheet
          key={sheet.target.appointmentId}
          workspace={workspace}
          target={sheet.target}
          today={today}
          onClose={onClose}
        />
      )
  }
}
