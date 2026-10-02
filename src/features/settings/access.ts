import type { MemberRole } from '@/shared/lib/domain'

/**
 * Who sees the 1.6 settings screens (contract 1.6 D16): owner and manager (SPEC §5: the manager is
 * the owner without billing and critical actions). Staff see only «Ειδοποιήσεις». The server
 * enforces the same rule (RLS `_write` policies, the `_impl` role checks); this only hides what
 * would be refused.
 */
export function canManageSettings(role: MemberRole): boolean {
  return role === 'owner' || role === 'manager'
}
