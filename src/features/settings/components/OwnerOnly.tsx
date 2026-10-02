import { Navigate, Outlet } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import { isOwner } from '../access'

/**
 * Gate of the owner-only settings routes (contract 1.7 §6.1, D6): «Μέλη» and «Ταυτότητα
 * επιχείρησης». Anyone else goes back to the settings index. The role is the one the member route
 * read from `business_members` (never the JWT); the server refuses their calls anyway.
 */
export function OwnerOnly() {
  const { membership } = useMember()
  return isOwner(membership.role) ? <Outlet /> : <Navigate to="/settings" replace />
}
