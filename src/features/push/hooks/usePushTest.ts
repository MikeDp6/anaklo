import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  detectInstallContext,
  needsInstall,
  readInstallEnvironment,
} from '@/features/auth/installGate'
import { sendTestPush } from '../api'
import { readOneSignalAppId } from '../env'
import {
  enablePush,
  PushCancelled,
  readPushFacts,
  readSubscriptionId,
  startPush,
  watchSubscription,
  type OneSignalApi,
} from '../oneSignal'
import { pushStatus, type PushStatus } from '../pushStatus'

/**
 * The temporary push test of step 1.1 (ADR-0010 §3): loads the SDK after sign-in (without any
 * user identity), asks for permission only on a tap, reads this device's subscription id and
 * sends a test push to it via `spike-push`. A sign-out while this is still loading or enabling
 * cancels it (`startPush`, `enablePush`), so unmounting needs nothing more here.
 */
export function usePushTest() {
  const [oneSignal, setOneSignal] = useState<OneSignalApi | null>(null)
  const [status, setStatus] = useState<PushStatus>('loading')
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const test = useMutation({ mutationFn: sendTestPush })

  useEffect(() => {
    const appId = readOneSignalAppId()
    if (!appId) return
    let active = true
    startPush(appId).then(
      (loadedSdk) => {
        if (!active) return
        setOneSignal(loadedSdk)
        setStatus(pushStatus(readPushFacts(loadedSdk)))
        // A device enabled earlier already has its subscription.
        setSubscriptionId(readSubscriptionId(loadedSdk))
      },
      () => {
        if (active) setStatus('failed')
      },
    )
    return () => {
      active = false
    }
  }, [])

  // OneSignal may report the subscription (or a change of it) after the first read.
  useEffect(() => {
    if (!oneSignal) return
    return watchSubscription(oneSignal, () => {
      setStatus(pushStatus(readPushFacts(oneSignal)))
      setSubscriptionId(readSubscriptionId(oneSignal))
    })
  }, [oneSignal])

  /** Must stay synchronous up to the permission request (tap handler, see enablePush). */
  function enable(): void {
    if (!oneSignal) return
    if (needsInstall(detectInstallContext(readInstallEnvironment()))) {
      setStatus('needsInstall')
      return
    }
    enablePush(oneSignal).then(
      (id) => {
        setStatus(pushStatus(readPushFacts(oneSignal)))
        setSubscriptionId(id)
      },
      (error: unknown) => {
        if (!(error instanceof PushCancelled)) setStatus('failed')
      },
    )
  }

  return {
    status,
    canEnable: oneSignal !== null && status === 'off',
    enable,
    canSendTest: subscriptionId !== null && !test.isPending,
    sendTest: () => {
      if (subscriptionId !== null) test.mutate(subscriptionId)
    },
    testResult: test.isSuccess ? 'sent' : test.isError ? 'failed' : null,
  } as const
}
