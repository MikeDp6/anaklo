import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { REPO_ROOT, localSupabase } from '../../scripts/lib/cli.mjs'
import { provisionBusiness, type Summary } from '../../scripts/lib/provision-apply.mjs'
import { parseProvisionFile } from '../../scripts/lib/provision-schema.mjs'
import {
  addLocalDays,
  localDateTimeToInstant,
  toLocalDate,
} from '../../supabase/functions/_shared/dates.ts'
import type { Database } from '../../src/shared/lib/database.types.ts'

/**
 * Dedicated synthetic shops for the step 1.6 e2e (contract 1.6 §2.10, D19): the settings and
 * absence specs change hours, closures, time off, the order and the policy, so they never run
 * on `demo-barber` (other specs book there). Each spec provisions its own shop per browser
 * project through the provisioning script's own code, against the LOCAL stack only
 * (`localSupabase()` refuses any non-local URL), with the stack's secret key read from
 * `supabase status` at run time. Provisioning is idempotent: a rerun resets the hours, the
 * order, the policy and who offers what to the file.
 */

/** The committed synthetic example (slug `demo-provision`). */
export const PROVISION_EXAMPLE_FILE = path.join(
  REPO_ROOT,
  'supabase',
  'provision',
  'demo-barber.example.json',
)

export interface E2eShop {
  businessId: string
  slug: string
  ownerEmail: string
  /** display name → id */
  staff: Readonly<Record<string, string>>
  /** service name → id */
  services: Readonly<Record<string, string>>
}

export type { Summary }

// Every e2e shop keeps a fixed zone in its file, as a real shop does; the specs read it from
// the file (never from the app).
const ZONE = 'Europe/Athens'

let stack: ReturnType<typeof localSupabase> | undefined

function adminClient() {
  stack ??= localSupabase()
  return createClient<Database>(stack.apiUrl, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

function byName<T>(rows: readonly T[], name: (row: T) => string, id: (row: T) => string) {
  return Object.freeze(Object.fromEntries(rows.map((row) => [name(row), id(row)])))
}

/** provisionBusiness() against the LOCAL stack (localSupabase() secret key), then the ids. */
export async function provisionLocal(file: unknown): Promise<{ summary: Summary; shop: E2eShop }> {
  const parsed = parseProvisionFile(file)
  if (!parsed.ok) throw new Error(`invalid e2e provisioning file:\n${parsed.errors.join('\n')}`)
  const { desired } = parsed
  const owner = desired.members.find((member) => member.role === 'owner')
  if (!owner) throw new Error('the e2e provisioning file has no owner login')

  const db = adminClient()
  const summary = await provisionBusiness(db, desired)

  const business = await db
    .from('businesses')
    .select('id, slug')
    .eq('slug', desired.business.slug)
    .single()
  if (business.error) throw new Error(`read the e2e shop: ${business.error.message}`)
  const [staff, services] = await Promise.all([
    db.from('staff').select('id, display_name').eq('business_id', business.data.id),
    db.from('services').select('id, name').eq('business_id', business.data.id),
  ])
  if (staff.error) throw new Error(`read the e2e staff: ${staff.error.message}`)
  if (services.error) throw new Error(`read the e2e services: ${services.error.message}`)

  return {
    summary,
    shop: {
      businessId: business.data.id,
      slug: business.data.slug,
      ownerEmail: owner.email,
      staff: byName(
        staff.data,
        (row) => row.display_name,
        (row) => row.id,
      ),
      services: byName(
        services.data.filter((row) => desired.services.some((s) => s.name === row.name)),
        (row) => row.name,
        (row) => row.id,
      ),
    },
  }
}

const TUE_TO_SAT = ['10:00-18:00']

/**
 * `project` = 'chrome' | 'safari' (from the Playwright project name), so parallel projects and
 * spec files never share a shop.
 * Slug `e2e-settings-<variant>-<project>`, owner `owner@e2e-settings-<variant>-<project>.test`;
 * staff «Ε2Ε Α», «Ε2Ε Β»; one service «Κούρεμα» 30′ / 13,00 € by both; Tue–Sat 10:00-18:00;
 * the policy written out so a rerun restores what a failed test left (slot step 15).
 */
export function settingsShopFile(project: string, variant: 'catalogue' | 'schedule'): unknown {
  const slug = `e2e-settings-${variant}-${project}`
  const hours = {
    tue: TUE_TO_SAT,
    wed: TUE_TO_SAT,
    thu: TUE_TO_SAT,
    fri: TUE_TO_SAT,
    sat: TUE_TO_SAT,
  }
  return {
    business: {
      slug,
      name: `E2E Settings ${variant} ${project}`,
      vertical: 'barber',
      timezone: ZONE,
      currency: 'EUR',
      locale: 'el',
      booking_enabled: true,
      messaging_enabled: false,
      policy: {
        slot_step_min: 15,
        min_notice_min: 60,
        max_advance_days: 60,
        cancel_min_notice_min: 120,
        auto_complete_after_min: 720,
        correction_window_days: 3,
        allow_any_staff: true,
        quiet_start: '22:00',
        quiet_end: '09:00',
        reminder_mode: '24h',
      },
    },
    services: [{ name: 'Κούρεμα', duration_min: 30, buffer_after_min: 0, price_cents: 1300 }],
    staff: [
      { display_name: 'Ε2Ε Α', color: '#2F6B5E', active: true, services: 'all', hours },
      { display_name: 'Ε2Ε Β', color: '#8A5A44', active: true, services: 'all', hours },
    ],
    members: [{ email: `owner@${slug}.test`, role: 'owner' }],
  }
}

// Flow 6 needs ≥ 2 h left in the shop's local day. The Athens shop runs while ≥ 3 h are left
// there; later in the evening (21:00–24:00 Athens, which CI runs often hit) a second shop in
// New York (7 h behind) takes over, so the flow never skips and also runs in a zone other than
// the seed's. The zone is part of the slug: a shop never changes zone (1.7
// change_business_identity), and provisioning is idempotent per slug.
const ABSENCE_ZONES = [
  { tag: '', zone: 'Europe/Athens' },
  { tag: 'ny-', zone: 'America/New_York' },
] as const
const ABSENCE_MIN_LEFT_MS = 3 * 60 * 60_000

function msLeftToday(now: Date, zone: string): number {
  const nextMidnight = localDateTimeToInstant(
    addLocalDays(toLocalDate(now, zone), 1),
    '00:00',
    zone,
  )
  return nextMidnight.getTime() - now.getTime()
}

/**
 * Slug `e2e-absence-<project>` (`e2e-absence-ny-<project>` late in the Athens evening), owner
 * `owner@<slug>.test`; staff «Απών», «Βασίλης», «Γιάννης»; «Κούρεμα» 30′ by all; every day
 * 00:00-23:59 (the flow needs two future appointments today, whatever the hour); SMS on (the
 * cancellation's SMS is the point).
 */
export function absenceShopFile(project: string, now: Date = new Date()): unknown {
  const pick =
    ABSENCE_ZONES.find(({ zone }) => msLeftToday(now, zone) >= ABSENCE_MIN_LEFT_MS) ??
    ABSENCE_ZONES[1]
  const slug = `e2e-absence-${pick.tag}${project}`
  const day = ['00:00-23:59']
  const hours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day }
  return {
    business: {
      slug,
      name: `E2E Absence ${project}`,
      vertical: 'barber',
      timezone: pick.zone,
      currency: 'EUR',
      locale: 'el',
      booking_enabled: true,
      messaging_enabled: true,
      policy: {
        slot_step_min: 30,
        min_notice_min: 0,
        max_advance_days: 60,
        cancel_min_notice_min: 120,
        auto_complete_after_min: 720,
        correction_window_days: 3,
        allow_any_staff: true,
        quiet_start: '22:00',
        quiet_end: '09:00',
        reminder_mode: '24h',
      },
    },
    services: [{ name: 'Κούρεμα', duration_min: 30, buffer_after_min: 0, price_cents: 1300 }],
    staff: [
      { display_name: 'Απών', color: '#2F6B5E', active: true, services: 'all', hours },
      { display_name: 'Βασίλης', color: '#8A5A44', active: true, services: 'all', hours },
      { display_name: 'Γιάννης', color: '#4F7CAC', active: true, services: 'all', hours },
    ],
    members: [{ email: `owner@${slug}.test`, role: 'owner' }],
  }
}
