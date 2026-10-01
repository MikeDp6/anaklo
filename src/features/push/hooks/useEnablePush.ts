import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { registerPushSubscription } from '../api'
import { enablePush, PushCancelled, PushRegisterFailed, type OneSignalApi } from '../oneSignal'
import type { EnableOutcome } from '../pushStatus'

/**
 * The «Ενεργοποίηση» tap (ADR-0010 §7): `enable` must be called straight from the tap handler,
 * because `enablePush` asks for the permission synchronously (iOS). The outcome stays `pending`
 * until my rows were read again, so the screen goes from the button straight to «ενεργές».
 */
export function useEnablePush(options: {
  readonly oneSignal: OneSignalApi | null
  readonly userId: string
  /** Re-reads the device (permission and opt-in) once the enable has ended. */
  readonly onSettled: () => void
}) {
  const { oneSignal, userId, onSettled } = options
  const queryClient = useQueryClient()
  const [outcome, setOutcome] = useState<EnableOutcome>('idle')

  async function run(sdk: OneSignalApi): Promise<void> {
    let next: EnableOutcome = 'idle'
    try {
      await enablePush(sdk, { register: registerPushSubscription })
    } catch (error) {
      // A sign-out won: this page is on its way to the login screen.
      if (error instanceof PushCancelled) return
      next = error instanceof PushRegisterFailed ? 'registerFailed' : 'failed'
    }
    await queryClient.invalidateQueries({ queryKey: proKeys.pushSubscriptions(userId) })
    onSettled()
    setOutcome(next)
  }

  return {
    outcome,
    enable: (): void => {
      if (!oneSignal || outcome === 'pending') return
      setOutcome('pending')
      void run(oneSignal)
    },
  } as const
}
