import { SubscriptionIdBody } from '@/shared/lib/onesignal'
import { supabase } from '@/shared/lib/supabase'

/**
 * Asks the temporary `spike-push` Edge Function (ADR-0010 §3, owners only, JWT required) to send
 * a test notification to ONE OneSignal subscription: this device's, as the SDK reported it
 * (`OneSignal.User.PushSubscription.id`). The app never claims a user identity with OneSignal
 * (ADR-0010 §2). Deleted with the function after the test.
 */
export async function sendTestPush(subscriptionId: string): Promise<void> {
  const body = SubscriptionIdBody.safeParse({ subscription_id: subscriptionId })
  if (!body.success) throw new Error('not a OneSignal subscription id')
  const result = await supabase.functions.invoke<unknown>('spike-push', {
    method: 'POST',
    body: body.data,
  })
  const error: unknown = result.error
  if (error) throw error instanceof Error ? error : new Error('spike-push failed')
}
