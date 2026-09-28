import { z } from 'zod/mini'

// Public OneSignal app id (ADR-0010 §2); one app per environment. Empty hides the push test.
const OneSignalAppId = z.optional(z.union([z.literal(''), z.guid()]))

export function readOneSignalAppId(): string | null {
  const parsed = OneSignalAppId.safeParse(import.meta.env.VITE_ONESIGNAL_APP_ID)
  return parsed.success && parsed.data ? parsed.data : null
}

/** The temporary push test of step 1.1 (ADR-0010 §3) shows only where OneSignal is configured. */
export function isPushTestEnabled(): boolean {
  return readOneSignalAppId() !== null
}
