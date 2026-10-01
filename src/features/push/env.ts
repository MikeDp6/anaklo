import { z } from 'zod/mini'

// Public OneSignal app id (ADR-0010 §2); one app per environment. Empty or missing: push is not
// available here (locally until step 1.10), and the SDK never loads.
const OneSignalAppId = z.optional(z.union([z.literal(''), z.guid()]))

export function readOneSignalAppId(): string | null {
  const parsed = OneSignalAppId.safeParse(import.meta.env.VITE_ONESIGNAL_APP_ID)
  return parsed.success && parsed.data ? parsed.data : null
}
