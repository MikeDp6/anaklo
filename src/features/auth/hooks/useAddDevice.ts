import { useNavigate } from 'react-router'
import { SECURITY_PATH } from '../loaders'
import { highestRole } from '../mfa-route'
import { useMember } from './useMember'
import { useMfaFactors } from './useMfaFactors'
import type { SecurityLocationState } from './useSecurityPage'

/**
 * «Προσθήκη συσκευής» from Ρυθμίσεις → Ασφάλεια (contract 1.7 §6.4, mode `add`): the current
 * devices (for the default name «Συσκευή N»), then back to «Ασφάλεια» with the result.
 */
export function useAddDevice() {
  const { user, memberships } = useMember()
  const role = highestRole(memberships.map((row) => row.role))
  const managesDevices = role === 'owner' || role === 'manager'
  const factors = useMfaFactors(user.userId, managesDevices)
  const navigate = useNavigate()
  const state: SecurityLocationState = { deviceAdded: true }
  return {
    managesDevices,
    userId: user.userId,
    factors,
    done: () => void navigate(SECURITY_PATH, { replace: true, state }),
  } as const
}
