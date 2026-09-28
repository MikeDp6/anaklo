import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import { readProEnv } from './env'

/**
 * Supabase client for the PRO app only. Import it from feature `api.ts` files, never from
 * components (ESLint enforces this) and never from the booking page (it must stay small).
 */
const { supabaseUrl, publishableKey } = readProEnv()

export const supabase = createClient<Database>(supabaseUrl, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Staff sign in with a 6-digit email code, never a link (ADR-0009 §1): no session is ever
    // read from the URL, so a crafted link cannot plant one.
    detectSessionInUrl: false,
  },
})
