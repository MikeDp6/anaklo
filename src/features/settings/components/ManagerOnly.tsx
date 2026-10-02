import { Navigate, Outlet } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import { canManageSettings } from '../access'

/**
 * Gate of the owner/manager settings routes (contract 1.6 §4.1): anyone else goes back to the
 * settings index, which shows them «Ειδοποιήσεις» only. The server refuses their writes anyway.
 */
export function ManagerOnly() {
  const { membership } = useMember()
  return canManageSettings(membership.role) ? <Outlet /> : <Navigate to="/settings" replace />
}
