// The provisioning file (ADR-0009 §8, plan 1.1): one business with its catalogue, staff, weekly
// hours and staff logins. Real files live OUTSIDE the repository; the only committed one is the
// synthetic supabase/provision/demo-barber.example.json.
//
// The database stays the source of truth for value ranges (CHECK constraints). This schema checks
// the shape, the cross references and whatever must fail BEFORE anything is written: overlapping
// hours would otherwise fail after the delete of a delete-then-insert (working_hours_no_overlap
// is not deferrable) and leave the staff member without hours.
import { z } from 'zod/mini'
import { isValidTimeZone } from '../../supabase/functions/_shared/dates.ts'
import {
  Locale,
  MemberRole,
  REMINDER_MODES,
  Vertical,
} from '../../supabase/functions/_shared/domain.ts'
import {
  HOUR_MINUTE,
  WEEKDAY_KEYS,
  WEEKDAYS,
  findOverlaps as findIntervalOverlaps,
  parseInterval,
} from '../../supabase/functions/_shared/hours.ts'
import { normalizePhone } from '../../supabase/functions/_shared/phone.ts'
import { BusinessTheme } from '../../src/shared/lib/theme.ts'

// The hours vocabulary lives in supabase/functions/_shared/hours.ts (shared with the pro app's
// week editor, contract 1.6 §2.9); re-exported here with no change of behaviour.
export { WEEKDAYS, parseInterval }

/** @typedef {import('../../supabase/functions/_shared/hours.ts').WeekdayKey} WeekdayKey */

// Same patterns as the businesses_slug_format constraint and private.is_valid_timezone, so a bad
// file fails here with a readable message; the database still enforces them (and the reserved
// slugs, which only it knows).
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/
const IANA_ZONE = /^[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/
const INTERVAL = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

/** @param {string} text */
function isValidInterval(text) {
  if (!INTERVAL.test(text)) return false
  const { start, end } = parseInterval(text)
  return end > start
}

/**
 * Pairs [earlier, later] of intervals (indexes into `intervals`) that overlap on one day.
 * Back-to-back intervals ("09:00-14:00", "14:00-18:00") do not overlap, as in the database ('[)').
 * The "HH:MM-HH:MM" form of hours.ts `findOverlaps` (same semantics).
 * @param {readonly string[]} intervals valid "HH:MM-HH:MM" strings
 * @returns {Array<[number, number]>}
 */
export function findOverlaps(intervals) {
  return findIntervalOverlaps(intervals.map(parseInterval))
}

/** @param {number} max */
const Name = (max) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max))
const NonNegativeInt = z.int().check(z.gte(0))

const Interval = z.string().check(
  z.superRefine((text, ctx) => {
    if (!INTERVAL.test(text)) {
      ctx.addIssue({
        code: 'custom',
        input: text,
        message: 'expected "HH:MM-HH:MM" in 24-hour local time, e.g. "09:00-14:00"',
      })
    } else if (!isValidInterval(text)) {
      ctx.addIssue({
        code: 'custom',
        input: text,
        message: 'the end must be after the start (hours never cross midnight)',
      })
    }
  }),
)

const Day = z.optional(z.array(Interval))

const WeeklyHours = z
  .strictObject({ mon: Day, tue: Day, wed: Day, thu: Day, fri: Day, sat: Day, sun: Day })
  .check(
    z.superRefine((hours, ctx) => {
      for (const day of WEEKDAY_KEYS) {
        // Malformed intervals already have their own issue; compare the well-formed ones.
        const valid = (hours[day] ?? [])
          .map((text, index) => ({ text, index }))
          .filter(({ text }) => isValidInterval(text))
        for (const [earlier, later] of findOverlaps(valid.map(({ text }) => text))) {
          const a = valid[earlier]
          const b = valid[later]
          if (!a || !b) continue
          ctx.addIssue({
            code: 'custom',
            path: [day, b.index],
            input: b.text,
            message: `"${b.text}" overlaps "${a.text}" (back-to-back is fine)`,
          })
        }
      }
    }),
  )

const Email = z.email().check(z.toLowerCase())

const Login = z.strictObject({ email: Email, role: MemberRole })

const StaffService = z.union(
  [
    Name(80),
    z.strictObject({
      service: Name(80),
      custom_duration_min: z.optional(z.nullable(z.int())),
      custom_price_cents: z.optional(z.nullable(NonNegativeInt)),
    }),
  ],
  {
    error:
      'expected a service name or { "service": name, "custom_duration_min"?, "custom_price_cents"? }',
  },
)

const Staff = z.strictObject({
  display_name: Name(60),
  color: z.optional(z.nullable(z.string().check(z.regex(HEX_COLOR, 'expected #RRGGBB')))),
  sort: z.optional(z.int()),
  active: z.optional(z.boolean()),
  /** A login for this staff member (Auth user + business_members row with staff_id). */
  login: z.optional(Login),
  /** "all" = every service of the file; a list = exactly these; omitted = leave as is. */
  services: z.optional(
    z.union([z.literal('all'), z.array(StaffService)], {
      error: 'expected "all" or a list of services',
    }),
  ),
  /** Weekly hours; omitted = leave as is, present = exactly these (days not listed are off). */
  hours: z.optional(WeeklyHours),
})

const Category = z.strictObject({ name: Name(60), sort: z.optional(z.int()) })

const Service = z.strictObject({
  name: Name(80),
  category: z.optional(z.nullable(Name(60))),
  duration_min: z.int(),
  buffer_after_min: z.optional(z.int()),
  /** Integer cents (CLAUDE.md rule 5): 1300 = 13.00. */
  price_cents: NonNegativeInt,
  online_bookable: z.optional(z.boolean()),
  active: z.optional(z.boolean()),
  sort: z.optional(z.int()),
})

const Policy = z.strictObject({
  slot_step_min: z.optional(z.int()),
  min_notice_min: z.optional(z.int()),
  max_advance_days: z.optional(z.int()),
  cancel_min_notice_min: z.optional(z.int()),
  auto_complete_after_min: z.optional(z.int()),
  correction_window_days: z.optional(z.int()),
  allow_any_staff: z.optional(z.boolean()),
  /** Quiet hours of the SMS (local "HH:MM"; the database checks the 1–12 h window). */
  quiet_start: z.optional(z.string().check(z.regex(HOUR_MINUTE, 'expected "HH:MM"'))),
  quiet_end: z.optional(z.string().check(z.regex(HOUR_MINUTE, 'expected "HH:MM"'))),
  reminder_mode: z.optional(z.enum(REMINDER_MODES)),
})

const Business = z.strictObject({
  /** Create-only, like timezone, currency and vertical (ADR-0009 §8). */
  slug: z
    .string()
    .check(
      z.regex(SLUG, 'expected 3–40 characters: a-z, 0-9 and "-", not starting or ending with "-"'),
    ),
  name: Name(80),
  vertical: Vertical,
  timezone: z.string().check(
    z.superRefine((zone, ctx) => {
      if (!IANA_ZONE.test(zone)) {
        ctx.addIssue({
          code: 'custom',
          input: zone,
          message: 'expected an IANA Area/Location time zone name',
        })
      } else if (!isValidTimeZone(zone)) {
        ctx.addIssue({ code: 'custom', input: zone, message: 'unknown time zone' })
      }
    }),
  ),
  currency: z.string().check(z.regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code such as EUR')),
  locale: Locale,
  /** Normalised to E.164 with phone.ts; null clears it. */
  phone: z.optional(
    z.nullable(
      z.string().check(z.refine((value) => normalizePhone(value).ok, 'not a valid phone number')),
    ),
  ),
  /** Shown on the booking page; null clears it. */
  address: z.optional(z.nullable(Name(200))),
  /** A map link for the booking page (https only, as businesses_maps_url); null clears it. */
  maps_url: z.optional(
    z.nullable(
      z
        .string()
        .check(z.trim(), z.regex(/^https:\/\//, 'expected an https:// link'), z.maxLength(500)),
    ),
  ),
  booking_enabled: z.optional(z.boolean()),
  messaging_enabled: z.optional(z.boolean()),
  policy: z.optional(Policy),
  theme: z.optional(BusinessTheme),
})

const Member = z.strictObject({ email: Email, role: MemberRole })

/**
 * Reports every value that appears more than once.
 * @param {readonly string[]} values
 * @param {(index: number, value: string) => void} report called for the 2nd, 3rd… occurrence
 */
function reportDuplicates(values, report) {
  const seen = new Set()
  values.forEach((value, index) => {
    if (seen.has(value)) report(index, value)
    seen.add(value)
  })
}

/** @param {string | { service: string }} entry */
const serviceNameOf = (entry) => (typeof entry === 'string' ? entry : entry.service)

export const ProvisionFile = z
  .strictObject({
    business: Business,
    categories: z.optional(z.array(Category)),
    services: z.optional(z.array(Service)),
    staff: z.array(Staff),
    /** Members without a staff row (e.g. a manager who does not take appointments). */
    members: z.optional(z.array(Member)),
  })
  .check(
    z.superRefine((file, ctx) => {
      /** @param {PropertyKey[]} path @param {string} message */
      const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message, input: file })
      const categories = file.categories ?? []
      const services = file.services ?? []
      const members = file.members ?? []

      const categoryNames = new Set(categories.map((category) => category.name))
      reportDuplicates(
        categories.map((category) => category.name),
        (i, name) => issue(['categories', i, 'name'], `duplicate category "${name}"`),
      )

      const serviceNames = new Set(services.map((service) => service.name))
      reportDuplicates(
        services.map((service) => service.name),
        (i, name) => issue(['services', i, 'name'], `duplicate service "${name}"`),
      )
      services.forEach((service, i) => {
        if (service.category != null && !categoryNames.has(service.category)) {
          issue(['services', i, 'category'], `unknown category "${service.category}"`)
        }
      })

      reportDuplicates(
        file.staff.map((person) => person.display_name),
        (i, name) => issue(['staff', i, 'display_name'], `duplicate staff member "${name}"`),
      )
      file.staff.forEach((person, i) => {
        if (!Array.isArray(person.services)) return
        const names = person.services.map(serviceNameOf)
        names.forEach((name, j) => {
          if (!serviceNames.has(name))
            issue(['staff', i, 'services', j], `unknown service "${name}"`)
        })
        reportDuplicates(names, (j, name) =>
          issue(['staff', i, 'services', j], `service "${name}" is listed twice`),
        )
      })

      const logins = [
        ...file.staff.flatMap((person, i) =>
          person.login ? [{ ...person.login, path: ['staff', i, 'login', 'email'] }] : [],
        ),
        ...members.map((member, i) => ({ ...member, path: ['members', i, 'email'] })),
      ]
      const emails = new Set()
      for (const login of logins) {
        if (emails.has(login.email)) issue(login.path, `email ${login.email} is used twice`)
        emails.add(login.email)
      }
      if (!logins.some((login) => login.role === 'owner')) {
        issue(['staff'], 'at least one login (staff[].login or members[]) must have role "owner"')
      }
    }),
  )

/** @typedef {z.infer<typeof ProvisionFile>} ProvisionFileData */

/**
 * @typedef {object} DesiredBusiness
 * @property {string} slug
 * @property {string} name
 * @property {string} vertical
 * @property {string} timezone
 * @property {string} currency
 * @property {string} locale
 * @property {string | null} [phone_e164]
 * @property {string | null} [address]
 * @property {string | null} [maps_url]
 * @property {boolean} [booking_enabled]
 * @property {boolean} [messaging_enabled]
 * @property {number} [slot_step_min]
 * @property {number} [min_notice_min]
 * @property {number} [max_advance_days]
 * @property {number} [cancel_min_notice_min]
 * @property {number} [auto_complete_after_min]
 * @property {number} [correction_window_days]
 * @property {boolean} [allow_any_staff]
 * @property {string} [quiet_start] local "HH:MM"
 * @property {string} [quiet_end] local "HH:MM"
 * @property {'24h' | 'evening_before'} [reminder_mode]
 * @property {import('../../src/shared/lib/theme.ts').BusinessTheme} [theme]
 */

/**
 * @typedef {{ name: string, sort: number }} DesiredCategory
 * @typedef {object} DesiredService
 * @property {string} name
 * @property {string | null} category
 * @property {number} duration_min
 * @property {number} [buffer_after_min]
 * @property {number} price_cents
 * @property {boolean} [online_bookable]
 * @property {boolean} [active]
 * @property {number} sort
 * @typedef {{ service: string, custom_duration_min: number | null, custom_price_cents: number | null }} DesiredStaffService
 * @typedef {{ weekday: number, start_time: string, end_time: string }} DesiredHours
 * @typedef {object} DesiredStaff
 * @property {string} display_name
 * @property {string | null} [color]
 * @property {number} sort
 * @property {boolean} [active]
 * @property {DesiredStaffService[]} [services] undefined = leave as is
 * @property {DesiredHours[]} [hours] undefined = leave as is
 * @typedef {{ email: string, role: 'owner' | 'manager' | 'staff', staff: string | null }} DesiredMember
 * @typedef {object} Desired
 * @property {DesiredBusiness} business
 * @property {DesiredCategory[]} categories
 * @property {DesiredService[]} services
 * @property {DesiredStaff[]} staff
 * @property {DesiredMember[]} members
 */

/**
 * Copies the keys whose value is not undefined (omitted in the file = leave the column as is).
 * @template {Record<string, unknown>} T
 * @param {T} value
 * @returns {Partial<T>}
 */
function definedOnly(value) {
  return /** @type {Partial<T>} */ (
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
  )
}

/**
 * The file in the shape the database needs: phone in E.164, hours as weekday rows, "all" expanded,
 * sort defaulting to the position in the file. Omitted optional fields stay undefined, which
 * means "database default on create, unchanged on update".
 * @param {ProvisionFileData} file
 * @returns {Desired}
 */
export function toDesired(file) {
  const { business, staff } = file
  const services = file.services ?? []
  /** @type {DesiredBusiness} */
  const desiredBusiness = {
    slug: business.slug,
    name: business.name,
    vertical: business.vertical,
    timezone: business.timezone,
    currency: business.currency,
    locale: business.locale,
    ...definedOnly({
      phone_e164: business.phone == null ? business.phone : toE164(business.phone),
      address: business.address,
      maps_url: business.maps_url,
      booking_enabled: business.booking_enabled,
      messaging_enabled: business.messaging_enabled,
      theme: business.theme,
      ...business.policy,
    }),
  }

  return {
    business: desiredBusiness,
    categories: (file.categories ?? []).map((category, index) => ({
      name: category.name,
      sort: category.sort ?? index,
    })),
    services: services.map((service, index) => ({
      ...definedOnly({
        buffer_after_min: service.buffer_after_min,
        online_bookable: service.online_bookable,
        active: service.active,
      }),
      name: service.name,
      category: service.category ?? null,
      duration_min: service.duration_min,
      price_cents: service.price_cents,
      sort: service.sort ?? index,
    })),
    staff: staff.map((person, index) => ({
      ...definedOnly({
        color: person.color,
        active: person.active,
        services:
          person.services === 'all'
            ? services.map((service) => ({
                service: service.name,
                custom_duration_min: null,
                custom_price_cents: null,
              }))
            : person.services?.map((entry) =>
                typeof entry === 'string'
                  ? { service: entry, custom_duration_min: null, custom_price_cents: null }
                  : {
                      service: entry.service,
                      custom_duration_min: entry.custom_duration_min ?? null,
                      custom_price_cents: entry.custom_price_cents ?? null,
                    },
              ),
        hours: person.hours && hoursRows(person.hours),
      }),
      display_name: person.display_name,
      sort: person.sort ?? index,
    })),
    members: [
      ...staff.flatMap((person) =>
        person.login ? [{ ...person.login, staff: person.display_name }] : [],
      ),
      ...(file.members ?? []).map((member) => ({ ...member, staff: null })),
    ],
  }
}

/**
 * @param {string} phone a value that passed the schema
 * @returns {string}
 */
function toE164(phone) {
  const result = normalizePhone(phone)
  if (!result.ok) throw new Error(`invalid phone number: ${phone}`)
  return result.e164
}

/**
 * @param {Partial<Record<WeekdayKey, string[]>>} hours
 * @returns {DesiredHours[]}
 */
function hoursRows(hours) {
  return WEEKDAY_KEYS.flatMap((day) =>
    (hours[day] ?? []).map((text) => {
      const { start, end } = parseInterval(text)
      return { weekday: WEEKDAYS[day], start_time: start, end_time: end }
    }),
  )
}

/**
 * Validates a parsed JSON value. Messages are English (operator tool output, not UI).
 * @param {unknown} input
 * @returns {{ ok: true, desired: Desired } | { ok: false, errors: string[] }}
 */
export function parseProvisionFile(input) {
  const result = ProvisionFile.safeParse(input, { error: z.locales.en().localeError })
  if (result.success) return { ok: true, desired: toDesired(result.data) }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const where = issue.path.map(String).join('.')
      return where ? `${where}: ${issue.message}` : issue.message
    }),
  }
}
