/**
 * Synthetic users of supabase/seed.sql (step 1.1). Emails end in `.test`; every sign-in code
 * lands in the local Mailpit. Keep in sync with the seed.
 */
export const DEMO_BUSINESS_ID = '00000000-0000-4000-8000-000000000001'

export const SEED_USERS = {
  owner: { id: '00000000-0000-4000-8000-00000000a001', email: 'owner@demo-barber.test' },
  manager: { id: '00000000-0000-4000-8000-00000000a002', email: 'manager@demo-barber.test' },
  staff: { id: '00000000-0000-4000-8000-00000000a003', email: 'alex@demo-barber.test' },
  /** Has an Auth account but no membership: sees «χωρίς πρόσβαση». */
  noMember: { id: '00000000-0000-4000-8000-00000000a004', email: 'nomember@demo-barber.test' },
} as const

/**
 * Step 1.7 (seed.sql, contract 1.7 §2.11): one owner per security scenario and engine, members of
 * demo-barber without a staff row and without any authenticator in the seed.
 */
export function enrollOwnerEmail(engine: 'chrome' | 'webkit'): string {
  return `owner-enroll-${engine}@demo-barber.test`
}
export function devicesOwnerEmail(engine: 'chrome' | 'webkit'): string {
  return `owner-devices-${engine}@demo-barber.test`
}
/** A manager of demo-barber (…a017), for the Nous reset rehearsal (Chromium only). */
export const RESET_MANAGER = {
  id: '00000000-0000-4000-8000-00000000a017',
  email: 'manager-reset@demo-barber.test',
} as const
