import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'
import { PUSH_PROVIDERS } from '@/shared/lib/domain'

/**
 * Answers of the push RPCs and the own-rows read (contract 1.5 §2.10, §4.3). The server decides
 * whose rows these are (`auth.uid()`, RLS `user_id = auth.uid()`): nothing here names a user.
 */

/** `register_push_subscription`: the row id, and whether it belonged to another user before. */
export const RegisterResponse = z.object({ id: Id, moved: z.boolean() })

/** `unregister_push_subscription`: how many of the caller's rows were deleted. */
export const UnregisterResponse = z.int().check(z.gte(0))

/** `push_subscriptions` rows of the signed-in user. A VAPID row has no `subscription_id`. */
export const MyPushSubscriptionRows = z.array(
  z.object({
    id: Id,
    provider: z.enum(PUSH_PROVIDERS),
    subscription_id: z.nullable(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
  }),
)

/** `request_test_push`: queued now, the same minute's row again, or why nothing was queued. */
export const TestPushResponse = z.object({
  message_id: z.nullable(Id),
  queued: z.boolean(),
  replayed: z.boolean(),
  reason: z.nullable(z.string()),
})

export interface RegisteredSubscription {
  readonly id: string
  readonly moved: boolean
}

export type PushProvider = (typeof PUSH_PROVIDERS)[number]

export interface MyPushSubscription {
  readonly id: string
  readonly provider: PushProvider
  readonly subscriptionId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TestPushResult {
  readonly messageId: string | null
  readonly queued: boolean
  readonly replayed: boolean
  readonly reason: string | null
}
