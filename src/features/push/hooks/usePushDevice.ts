import { useCallback, useEffect, useState } from 'react'
import { useNeedsInstall } from '@/features/auth/hooks/useNeedsInstall'
import { readOneSignalAppId } from '../env'
import {
  PushCancelled,
  readPushFacts,
  startPush,
  watchSubscription,
  type OneSignalApi,
} from '../oneSignal'
import type { PushDeviceState, PushFacts } from '../pushStatus'

type Loaded =
  | { readonly attempt: number; readonly failed: true }
  | { readonly attempt: number; readonly oneSignal: OneSignalApi; readonly facts: PushFacts }

/**
 * This device's push SDK for the Notifications screen (ADR-0010 §3, §7). It never loads without
 * `VITE_ONESIGNAL_APP_ID` (locally until 1.10) or on iOS outside the installed app, and it never
 * tells OneSignal who the user is. A sign-out while it loads cancels the start (`startPush`), so
 * unmounting needs nothing more. `retry` loads again after a failure; `refresh` re-reads the
 * device after an enable (the permission itself fires no subscription event).
 */
export function usePushDevice() {
  const [appId] = useState(readOneSignalAppId)
  const needsInstall = useNeedsInstall()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const blocked = appId === null ? 'unavailable' : needsInstall ? 'needsInstall' : null

  useEffect(() => {
    if (appId === null || blocked !== null) return
    let active = true
    startPush(appId).then(
      (oneSignal) => {
        if (active) setLoaded({ attempt, oneSignal, facts: readPushFacts(oneSignal) })
      },
      (error: unknown) => {
        // Cancelled by a sign-out: this page is on its way to the login screen.
        if (active && !(error instanceof PushCancelled)) setLoaded({ attempt, failed: true })
      },
    )
    return () => {
      active = false
    }
  }, [appId, blocked, attempt])

  const current = loaded?.attempt === attempt ? loaded : null
  const oneSignal = current && 'oneSignal' in current ? current.oneSignal : null

  const refresh = useCallback(() => {
    if (oneSignal) setLoaded({ attempt, oneSignal, facts: readPushFacts(oneSignal) })
  }, [attempt, oneSignal])

  // OneSignal reports a new subscription id, or an opt-in/opt-out, after the first read.
  useEffect(
    () => (oneSignal ? watchSubscription(oneSignal, refresh) : undefined),
    [oneSignal, refresh],
  )

  let device: PushDeviceState
  if (blocked !== null) device = { kind: blocked }
  else if (current === null) device = { kind: 'loading' }
  else if ('failed' in current) device = { kind: 'failed' }
  else device = { kind: 'ready', facts: current.facts }

  return {
    device,
    oneSignal,
    refresh,
    retry: () => setAttempt((value) => value + 1),
  } as const
}
