import type { Membership } from '@/features/auth/schema'

/**
 * Whether the app should read a column's appointments directly (RLS) or draw it from the busy
 * blocks of `busy_calendar` (contract 1.4 §3.2). Owner/manager read every column; staff only
 * their own staff row. The server enforces the rule; this only avoids requests that come back
 * empty.
 */
export function canReadAppointmentDetails(
  membership: Pick<Membership, 'role' | 'staffId'>,
  staffId: string,
): boolean {
  if (membership.role === 'owner' || membership.role === 'manager') return true
  return membership.staffId !== null && membership.staffId === staffId
}

/** Owner and manager see every amount (SPEC §5); staff only their own appointments' prices. */
export function seesBusinessAmounts(membership: Pick<Membership, 'role'>): boolean {
  return membership.role === 'owner' || membership.role === 'manager'
}
