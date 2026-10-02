import { useMember } from '@/features/auth/hooks/useMember'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { useStaff } from '@/features/staff/hooks/useStaff'
import type { StaffMember } from '@/features/staff/schema'
import { failureOf, type RpcFailureInfo } from '@/shared/lib/rpcError'
import type { Business } from '../schema'
import { useBusiness } from './useBusiness'

/** What every schedule settings screen needs before it can draw: the zone and the staff. */
export interface SettingsFrame {
  readonly businessId: string
  readonly business: Business
  /** Active and inactive (old rows keep their staff member's name). */
  readonly staff: readonly StaffMember[]
  readonly activeStaff: readonly StaffMember[]
  readonly staffNames: ReadonlyMap<string, string>
}

export type SettingsFrameState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: RpcFailureInfo; readonly retry: () => void }
  | {
      readonly status: 'ready'
      readonly frame: SettingsFrame
      /** A background refetch failed: the data stays, with the 1.4 `RefreshError` line. */
      readonly refreshFailure: RpcFailureInfo | null
      readonly retry: () => void
    }

/** The member's business and staff (60″ fresh, refetched on focus), loaded together. */
export function useSettingsFrame(): SettingsFrameState {
  const businessId = useMember().membership.businessId
  const business = useBusiness(businessId)
  const staff = useStaff(businessId)
  const retry = () => {
    void business.refetch()
    void staff.refetch()
  }
  const failed = [business, staff].find(failedWithoutData)
  if (failed) return { status: 'error', failure: failureOf(failed.error), retry }
  if (!business.data || !staff.data) return { status: 'loading' }
  const refreshFailed = [business, staff].find(failedRefresh)
  return {
    status: 'ready',
    frame: {
      businessId,
      business: business.data,
      staff: staff.data,
      activeStaff: staff.data.filter((member) => member.active),
      staffNames: new Map(staff.data.map((member) => [member.id, member.displayName])),
    },
    refreshFailure: refreshFailed ? failureOf(refreshFailed.error) : null,
    retry,
  }
}
