import type { Database } from '@/shared/lib/database.types'
import { OneSignalSubscriptionId } from '@/shared/lib/onesignal'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  MyPushSubscriptionRows,
  RegisterResponse,
  TestPushResponse,
  UnregisterResponse,
  type MyPushSubscription,
  type RegisteredSubscription,
  type TestPushResult,
} from './schema'

/**
 * Push data access of the pro app (contract 1.5 §4.3, ADR-0010 §2, §7). A subscription row is
 * written only for `auth.uid()` by the server: the app sends this device's OneSignal id and
 * never a user id, and never tells OneSignal who the user is.
 */

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

/** No answer after this: the push layer treats the call as failed (it has its own bounds too). */
const PUSH_RPC_TIMEOUT_MS = 10_000

function timeoutSignal(): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(PUSH_RPC_TIMEOUT_MS)
  const controller = new AbortController()
  setTimeout(
    () => controller.abort(new DOMException('timed out', 'TimeoutError')),
    PUSH_RPC_TIMEOUT_MS,
  )
  return controller.signal
}

function oneSignalId(subscriptionId: string): string {
  const parsed = OneSignalSubscriptionId.safeParse(subscriptionId)
  if (!parsed.success) throw new Error('not a OneSignal subscription id')
  return parsed.data
}

/** Binds this device's subscription to the signed-in user; it moves over from anyone else. */
export async function registerPushSubscription(
  subscriptionId: string,
): Promise<RegisteredSubscription> {
  const args: Args<'register_push_subscription'> = {
    p_provider: 'onesignal',
    p_subscription_id: oneSignalId(subscriptionId),
  }
  const { data, error, status } = await supabase
    .rpc('register_push_subscription', args)
    .abortSignal(timeoutSignal())
  throwIfFailed(error, status)
  return RegisterResponse.parse(data)
}

/** Deletes this device's row if it is the caller's (someone else's row: 0, never an error). */
export async function unregisterPushSubscription(subscriptionId: string): Promise<number> {
  const args: Args<'unregister_push_subscription'> = {
    p_subscription_id: oneSignalId(subscriptionId),
  }
  const { data, error, status } = await supabase
    .rpc('unregister_push_subscription', args)
    .abortSignal(timeoutSignal())
  throwIfFailed(error, status)
  return UnregisterResponse.parse(data)
}

/**
 * «Αποσύνδεση από όλες τις συσκευές» (contract 1.7 §6.7, 1.5 D13): every row of the caller goes,
 * also when this device never registered, before Auth ends every session.
 */
export async function unregisterAllPushSubscriptions(): Promise<number> {
  const args: Args<'unregister_push_subscription'> = { p_all: true }
  const { data, error, status } = await supabase
    .rpc('unregister_push_subscription', args)
    .abortSignal(timeoutSignal())
  throwIfFailed(error, status)
  return UnregisterResponse.parse(data)
}

/** The signed-in user's own subscriptions (RLS `user_id = auth.uid()`). */
export async function fetchMyPushSubscriptions(
  signal?: AbortSignal,
): Promise<MyPushSubscription[]> {
  let query = supabase
    .from('push_subscriptions')
    .select('id, provider, subscription_id, created_at, updated_at')
    .order('created_at', { ascending: true })
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return MyPushSubscriptionRows.parse(data).map((row) => ({
    id: row.id,
    provider: row.provider,
    subscriptionId: row.subscription_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

/** A test notification to every device of the caller (through `dispatch`, at most 1/minute). */
export async function requestTestPush(businessId: string): Promise<TestPushResult> {
  const args: Args<'request_test_push'> = { p_business_id: businessId }
  const { data, error, status } = await supabase
    .rpc('request_test_push', args)
    .abortSignal(timeoutSignal())
  throwIfFailed(error, status)
  const result = TestPushResponse.parse(data)
  return {
    messageId: result.message_id,
    queued: result.queued,
    replayed: result.replayed,
    reason: result.reason,
  }
}
