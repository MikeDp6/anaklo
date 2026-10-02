import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { useMember } from '@/features/auth/hooks/useMember'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Page } from '@/shared/ui/Page'
import { useStaff } from '../hooks/useStaff'
import { SettingsHeader } from './SettingsHeader'
import { StaffList, StaffListSkeleton } from './StaffList'
import { StaffSheet, type StaffSheetTarget } from './StaffSheet'

/**
 * /settings/staff (owner, manager; contract 1.6 §4.4): everyone in the shop's order with ▲/▼ and
 * «Ωράριο», one primary action «Νέος επαγγελματίας» (no login: invitations are 1.7).
 */
export function StaffPage() {
  const { t } = useTranslation('pro')
  const businessId = useMember().membership.businessId
  const staff = useStaff(businessId)
  const [sheet, setSheet] = useState<StaffSheetTarget | null>(null)

  return (
    <Page busy={staff.data === undefined && !staff.isError}>
      <SettingsHeader title={t('staffSettings.title')} />
      <Button
        block
        disabled={staff.data === undefined}
        onClick={() => setSheet({ kind: 'new', id: newIdempotencyKey() })}
      >
        {t('staffSettings.new')}
      </Button>
      {failedWithoutData(staff) ? (
        <LoadError failure={failureOf(staff.error)} onRetry={() => void staff.refetch()} />
      ) : staff.data === undefined ? (
        <StaffListSkeleton />
      ) : (
        <>
          {failedRefresh(staff) && (
            <RefreshError failure={failureOf(staff.error)} onRetry={() => void staff.refetch()} />
          )}
          <StaffList
            businessId={businessId}
            staff={staff.data}
            onOpen={(member) => setSheet({ kind: 'edit', member })}
          />
        </>
      )}
      {staff.data && sheet && (
        <StaffSheet
          businessId={businessId}
          target={sheet}
          staff={staff.data}
          onClose={() => setSheet(null)}
        />
      )}
    </Page>
  )
}
