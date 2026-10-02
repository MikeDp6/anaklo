import { z } from 'zod/mini'
import { normalizePhone } from './phone'

// Both values are public by design (the publishable key replaces the old anon key).
// Secret keys never reach the frontend; CI checks the build for them. The booking page needs
// neither: it calls the same-origin /api proxy, which adds the key (ADR-0008).
const PublishableKey = z
  .string()
  .check(z.regex(/^sb_publishable_[\w-]+$/, 'expected an sb_publishable_ key'))

/** The pro app connects to Supabase directly (Auth, Realtime, Storage). */
export function readProEnv(): { supabaseUrl: string; publishableKey: string } {
  return {
    supabaseUrl: z.url().parse(import.meta.env.VITE_SUPABASE_URL),
    publishableKey: PublishableKey.parse(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  }
}

/** How a user who lost their authenticator device reaches Nous (contract 1.7 §6.5, D19). */
export interface SupportContact {
  /** For a `mailto:` link; null when not configured (the link is hidden). */
  readonly email: string | null
  /** E.164, for a `tel:` link; null when not configured (the link is hidden). */
  readonly phone: string | null
}

const SupportEmail = z.email()

/**
 * Nous's public contact for «Χάσατε τη συσκευή σας;», from `VITE_SUPPORT_EMAIL` and
 * `VITE_SUPPORT_PHONE` (public by design: they are on the screen). A missing or malformed value
 * is null, never an error: the screen hides that link and still explains the reset.
 */
export function readSupportContact(): SupportContact {
  // Property by property: the build inlines each value (a whole `import.meta.env` would not be).
  return supportContact(import.meta.env.VITE_SUPPORT_EMAIL, import.meta.env.VITE_SUPPORT_PHONE)
}

/** The validation of `readSupportContact`, for any two raw values. */
export function supportContact(rawEmail: unknown, rawPhone: unknown): SupportContact {
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : ''
  const phone = typeof rawPhone === 'string' ? normalizePhone(rawPhone) : null
  return {
    email: email !== '' && SupportEmail.safeParse(email).success ? email : null,
    phone: phone?.ok ? phone.e164 : null,
  }
}
