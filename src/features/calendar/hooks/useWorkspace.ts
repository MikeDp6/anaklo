import { useMember } from '@/features/auth/hooks/useMember'
import type { Membership } from '@/features/auth/schema'
import { useServices } from '@/features/services/hooks/useServices'
import type { Service } from '@/features/services/schema'
import { useBusiness } from '@/features/settings/hooks/useBusiness'
import type { Business } from '@/features/settings/schema'
import { useStaff } from '@/features/staff/hooks/useStaff'
import type { StaffMember } from '@/features/staff/schema'
import { failureOf, type RpcFailureInfo } from '@/shared/lib/rpcError'
import { failedWithoutData } from '../queryState'

/** What every day screen needs before it can draw anything. */
export interface Workspace {
  readonly membership: Membership
  readonly businessId: string
  readonly business: Business
  /** Active and inactive (old appointments keep their staff member's name). */
  readonly staff: readonly StaffMember[]
  readonly activeStaff: readonly StaffMember[]
  readonly services: readonly Service[]
}

export type WorkspaceState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly failure: RpcFailureInfo; readonly retry: () => void }
  | { readonly status: 'ready'; readonly workspace: Workspace }

/** The member's business, staff and services (5′ cache), loaded together. */
export function useWorkspace(): WorkspaceState {
  const { membership } = useMember()
  const businessId = membership.businessId
  const business = useBusiness(businessId)
  const staff = useStaff(businessId)
  const services = useServices(businessId)

  // Only a query that never loaded blocks the screen. A failed background refetch (5′ stale, on
  // focus or reconnect) keeps its data: the day, «Σήμερα» and any open sheet stay mounted.
  const failed = [business, staff, services].find(failedWithoutData)
  if (failed) {
    return {
      status: 'error',
      failure: failureOf(failed.error),
      retry: () => {
        void business.refetch()
        void staff.refetch()
        void services.refetch()
      },
    }
  }
  if (!business.data || !staff.data || !services.data) return { status: 'loading' }
  return {
    status: 'ready',
    workspace: {
      membership,
      businessId,
      business: business.data,
      staff: staff.data,
      activeStaff: staff.data.filter((member) => member.active),
      services: services.data,
    },
  }
}
