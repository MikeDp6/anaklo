import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAppLocale } from '@/features/calendar/format'
import { failedWithoutData } from '@/features/calendar/queryState'
import { useBusiness } from '@/features/settings/hooks/useBusiness'
import { formatInstant } from '@/shared/lib/dates'
import { SECURITY_PATH } from '../loaders'
import { highestRole, needsSecondDevice } from '../mfa-route'
import { useMember } from './useMember'
import { useMfaFactors } from './useMfaFactors'
import { useRemoveFactor } from './useRemoveFactor'
import { useSignOutAll } from './useSignOutAll'

/** Set by the add-device wizard when it returns here: «Η συσκευή προστέθηκε.». */
export interface SecurityLocationState {
  readonly deviceAdded?: boolean
}

export const ADD_DEVICE_PATH = `${SECURITY_PATH}/add-device`

function deviceAdded(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'deviceAdded' in state
    ? state.deviceAdded === true
    : false
}

/**
 * Ρυθμίσεις → Ασφάλεια (contract 1.7 §6.7). Owners and managers (in any business: the devices
 * belong to the user) manage their authenticator devices; everyone may sign out of every device.
 * Devices are listed oldest first with their date in the business's zone. The last device cannot
 * be removed (the button is disabled here, the server refuses it anyway: AN027).
 */
export function useSecurityPage() {
  const { user, membership, memberships } = useMember()
  const role = highestRole(memberships.map((row) => row.role))
  const managesDevices = role === 'owner' || role === 'manager'
  const factors = useMfaFactors(user.userId, managesDevices)
  const business = useBusiness(membership.businessId)
  const locale = useAppLocale()
  const remove = useRemoveFactor(user.userId)
  const signOutAll = useSignOutAll()
  const navigate = useNavigate()
  const location = useLocation()
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const timeZone = business.data?.timeZone ?? null
  const list = factors.data ?? null
  // The zone only dates the devices. While it loads the list waits (no dates popping in); when
  // its read failed the list is drawn without dates, so «Αφαίρεση» and «Προσθήκη συσκευής» never
  // hang on it (the read retries on focus and on the 60″ refetch).
  const zoneSettled = timeZone !== null || failedWithoutData(business)

  return {
    managesDevices,
    factors,
    list,
    /** Ready to draw the list: the devices, and the business zone for their dates or its failure. */
    ready: list !== null && zoneSettled,
    single: list !== null && needsSecondDevice(list.length),
    canRemove: list !== null && list.length >= 2,
    /** The date a device was added, in the business zone; null while the zone is unknown. */
    addedOn: (createdAt: string): string | null =>
      timeZone
        ? formatInstant(new Date(createdAt), timeZone, locale, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : null,
    deviceAdded: deviceAdded(location.state),
    addDevice: () => void navigate(ADD_DEVICE_PATH),
    remove,
    confirming,
    askRemove: (factorId: string) => {
      remove.reset()
      setConfirming(factorId)
    },
    cancelRemove: () => setConfirming(null),
    confirmRemove: (factorId: string) => {
      setConfirming(null)
      remove.submit(factorId)
    },
    signOutAll,
    confirmingSignOut,
    askSignOutAll: () => setConfirmingSignOut(true),
    cancelSignOutAll: () => {
      signOutAll.reset()
      setConfirmingSignOut(false)
    },
  } as const
}

export type SecurityPageState = ReturnType<typeof useSecurityPage>
