import { useMember } from '@/features/auth/hooks/useMember'
import { notificationsView } from '../pushStatus'
import { useEnablePush } from './useEnablePush'
import { useMyPushSubscriptions } from './useMyPushSubscriptions'
import { usePushDevice } from './usePushDevice'
import { useTestPush } from './useTestPush'

/**
 * Settings → «Ειδοποιήσεις» (contract 1.5 §4.1): the device, my rows, the enable and the test
 * push, reduced to one status line and one primary action. Notifications are per user, so every
 * role sees the same screen.
 */
export function useNotificationsSettings() {
  const { user, membership } = useMember()
  const push = usePushDevice()
  const rows = useMyPushSubscriptions(user.userId, push.device.kind === 'ready')
  const enabling = useEnablePush({
    oneSignal: push.oneSignal,
    userId: user.userId,
    onSettled: push.refresh,
  })
  const test = useTestPush(membership.businessId)

  // A failed read counts as no rows: «Ενεργοποίηση» registers again (the same row, idempotent).
  const registeredIds =
    rows.data?.flatMap((row) => (row.subscriptionId ? [row.subscriptionId] : [])) ??
    (rows.isError ? [] : undefined)
  const view = notificationsView({ device: push.device, registeredIds, enable: enabling.outcome })

  return {
    status: view.status,
    action: view.action,
    enabling: enabling.outcome === 'pending',
    /** Straight from the tap handler (the permission prompt); after a failed load: load again. */
    enable: (): void => {
      if (push.oneSignal) enabling.enable()
      else push.retry()
    },
    testing: test.pending,
    sendTest: test.send,
    testMessage: test.message,
  } as const
}
