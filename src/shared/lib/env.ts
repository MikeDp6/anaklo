import { z } from 'zod/mini'

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
