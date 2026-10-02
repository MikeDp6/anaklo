import { WEEKDAY_KEYS } from '@fn-shared/hours.ts'

/**
 * Exit criterion of step 1.6 (contract 1.6 §5.1): «the provisioning JSON and the screens
 * describe the same shop». Every field of the provisioning file (`ProvisionFile` of
 * scripts/lib/provision-schema.mjs) is either a field of a settings form, shown by a settings
 * list, or written by the script only (with the reason). `provisionCoverage.test.ts` walks the
 * schema and the form schemas and fails when something is left out.
 *
 * Paths: object keys joined with `.`, `[]` for the items of a list; an entry covers its path and
 * everything under it (`staff[].services` covers `"all"`, names and `{ service, custom_… }`).
 */

/** The form schemas a screen field lives in (React Hook Form + zodResolver). */
export type CoverageForm =
  'BookingPolicyFormSchema' | 'ServiceFormSchema' | 'StaffFormSchema' | 'WeekHoursFormSchema'

export type CoverageEntry =
  /** A field of a form: `key` in that schema (dotted for nested objects). */
  | { readonly path: string; readonly form: CoverageForm; readonly key: string }
  /** Shown by a settings list, changed there without a form (e.g. the staff order). */
  | { readonly path: string; readonly list: string }
  /** Written by provisioning only, in Phase 1. */
  | { readonly path: string; readonly script: string }

const IDENTITY = 'create-only; changed only by change_business_identity (1.7)'
const PROFILE = 'no business profile screen in Phase 1 (contract 1.6 D15)'

export const PROVISION_COVERAGE: readonly CoverageEntry[] = [
  { path: 'business.slug', script: IDENTITY },
  { path: 'business.timezone', script: IDENTITY },
  { path: 'business.currency', script: IDENTITY },
  { path: 'business.vertical', script: 'create-only; fixed in Phase 1 (plan D6)' },
  { path: 'business.name', script: PROFILE },
  { path: 'business.locale', script: PROFILE },
  { path: 'business.phone', script: PROFILE },
  { path: 'business.address', script: PROFILE },
  { path: 'business.maps_url', script: PROFILE },
  { path: 'business.theme', script: 'the theme changes only by script (plan 1.6)' },
  { path: 'business.booking_enabled', form: 'BookingPolicyFormSchema', key: 'bookingEnabled' },
  { path: 'business.messaging_enabled', form: 'BookingPolicyFormSchema', key: 'messagingEnabled' },
  { path: 'business.policy.slot_step_min', form: 'BookingPolicyFormSchema', key: 'slotStepMin' },
  { path: 'business.policy.min_notice_min', form: 'BookingPolicyFormSchema', key: 'minNoticeMin' },
  {
    path: 'business.policy.max_advance_days',
    form: 'BookingPolicyFormSchema',
    key: 'maxAdvanceDays',
  },
  {
    path: 'business.policy.cancel_min_notice_min',
    form: 'BookingPolicyFormSchema',
    key: 'cancelMinNoticeMin',
  },
  {
    path: 'business.policy.auto_complete_after_min',
    form: 'BookingPolicyFormSchema',
    key: 'autoCompleteAfterMin',
  },
  {
    path: 'business.policy.correction_window_days',
    form: 'BookingPolicyFormSchema',
    key: 'correctionWindowDays',
  },
  {
    path: 'business.policy.allow_any_staff',
    form: 'BookingPolicyFormSchema',
    key: 'allowAnyStaff',
  },
  { path: 'business.policy.quiet_start', form: 'BookingPolicyFormSchema', key: 'quietStart' },
  { path: 'business.policy.quiet_end', form: 'BookingPolicyFormSchema', key: 'quietEnd' },
  { path: 'business.policy.reminder_mode', form: 'BookingPolicyFormSchema', key: 'reminderMode' },
  {
    path: 'categories[]',
    script: 'categories only by provisioning (plan 1.6); ServiceList groups, ServiceSheet options',
  },
  { path: 'services[].name', form: 'ServiceFormSchema', key: 'name' },
  { path: 'services[].category', form: 'ServiceFormSchema', key: 'categoryId' },
  { path: 'services[].duration_min', form: 'ServiceFormSchema', key: 'durationMin' },
  { path: 'services[].buffer_after_min', form: 'ServiceFormSchema', key: 'bufferAfterMin' },
  { path: 'services[].price_cents', form: 'ServiceFormSchema', key: 'priceCents' },
  { path: 'services[].online_bookable', form: 'ServiceFormSchema', key: 'onlineBookable' },
  { path: 'services[].active', form: 'ServiceFormSchema', key: 'active' },
  { path: 'services[].sort', script: 'no service reordering in 1.6 (D13); the ServiceList order' },
  { path: 'staff[].display_name', form: 'StaffFormSchema', key: 'displayName' },
  { path: 'staff[].color', form: 'StaffFormSchema', key: 'color' },
  { path: 'staff[].active', form: 'StaffFormSchema', key: 'active' },
  { path: 'staff[].sort', list: 'StaffList order (▲/▼, set_staff_order)' },
  // The same relation seen per service: «Ποιοι την κάνουν» with custom duration and price.
  { path: 'staff[].services', form: 'ServiceFormSchema', key: 'offers' },
  ...WEEKDAY_KEYS.map((day): CoverageEntry => ({
    path: `staff[].hours.${day}`,
    form: 'WeekHoursFormSchema',
    key: `days.${day}`,
  })),
  { path: 'staff[].login', script: 'logins and invitations come in 1.7' },
  { path: 'members[]', script: 'members and invitations come in 1.7' },
]

/**
 * Form fields that have no provisioning counterpart (none today: every form field is shop
 * configuration that the file can also set). Closures, time off and the absence are screens
 * only: day-to-day operations, never in the file.
 */
export const SCREEN_ONLY_FORM_KEYS: Readonly<Record<CoverageForm, readonly string[]>> = {
  BookingPolicyFormSchema: [],
  ServiceFormSchema: [],
  StaffFormSchema: [],
  WeekHoursFormSchema: [],
}

/** Whether `entry` covers `leaf` (the same path, or one under it). */
export function covers(entry: string, leaf: string): boolean {
  return leaf === entry || leaf.startsWith(`${entry}.`) || leaf.startsWith(`${entry}[`)
}
