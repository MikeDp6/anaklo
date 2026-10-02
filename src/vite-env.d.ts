/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  /** Public OneSignal app id (step 1.1 push test); empty hides the test buttons. */
  readonly VITE_ONESIGNAL_APP_ID?: string
  /** Nous support contact on «Χάσατε τη συσκευή σας;» (contract 1.7 D19); empty hides it. */
  readonly VITE_SUPPORT_EMAIL?: string
  /** E.164; empty hides the call link. */
  readonly VITE_SUPPORT_PHONE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
