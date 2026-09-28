/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  /** Public OneSignal app id (step 1.1 push test); empty hides the test buttons. */
  readonly VITE_ONESIGNAL_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
