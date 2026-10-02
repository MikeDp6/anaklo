import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'
import { toHm } from '@fn-shared/hours.ts'

export const StaffRow = z.object({
  id: Id,
  display_name: z.string(),
  color: z.nullable(z.string()),
  sort: z.int(),
  active: z.boolean(),
})
export const StaffRows = z.array(StaffRow)

export interface StaffMember {
  readonly id: string
  readonly displayName: string
  readonly color: string | null
  readonly sort: number
  readonly active: boolean
}

export function toStaff(rows: z.infer<typeof StaffRows>): StaffMember[] {
  return rows.map(toStaffMember)
}

export function toStaffMember(row: z.infer<typeof StaffRow>): StaffMember {
  return {
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    sort: row.sort,
    active: row.active,
  }
}

/** `id → display name`, also for inactive staff (old appointments keep their staff member). */
export function staffNames(staff: readonly StaffMember[]): ReadonlyMap<string, string> {
  return new Map(staff.map((member) => [member.id, member.displayName]))
}

// ---------------------------------------------------------------------------------------------
// Settings (contract 1.6 §3.1–3.2)
// ---------------------------------------------------------------------------------------------

export interface StaffInput {
  /** Generated when the sheet opened for a new staff member; kept across retries. */
  readonly id: string
  readonly displayName: string
  readonly color: string | null
  readonly active: boolean
  /** Used on create only (`set_staff_order` changes it afterwards). */
  readonly sort: number
}

/** `set_staff_order` (§2.5.6): the new order. */
export const StaffOrderResponse = z.array(z.object({ id: Id, sort: z.int() }))
export type StaffOrder = z.infer<typeof StaffOrderResponse>

/** 'HH:MM'; an end may be '24:00'. */
export type Hm = string

export interface WeekRow {
  /** 0 = Sunday … 6 = Saturday (extract(dow)). */
  readonly weekday: number
  readonly startTime: Hm
  readonly endTime: Hm
}

export interface WeekHoursResult {
  readonly staffId: string
  readonly changed: boolean
  readonly rows: readonly WeekRow[]
  readonly conflictCount: number
}

const Weekday = z.int().check(z.gte(0), z.lte(6))
/** A Postgres `time` ('09:00:00') or an `HH:MM` from an RPC; always shown as `HH:MM`. */
const TimeText = z.string().check(z.regex(/^\d{2}:\d{2}(:\d{2})?$/))

export const WeekHoursRows = z.array(
  z.object({ weekday: Weekday, start_time: TimeText, end_time: TimeText }),
)

/** `replace_week_hours` (§2.5.1). */
export const WeekHoursResponse = z.object({
  staff_id: Id,
  changed: z.boolean(),
  rows: WeekHoursRows,
  conflict_count: z.int().check(z.gte(0)),
})

export function toWeekRowList(rows: z.infer<typeof WeekHoursRows>): WeekRow[] {
  return rows.map((row) => ({
    weekday: row.weekday,
    startTime: toHm(row.start_time),
    endTime: toHm(row.end_time),
  }))
}

export function toWeekHoursResult(row: z.infer<typeof WeekHoursResponse>): WeekHoursResult {
  return {
    staffId: row.staff_id,
    changed: row.changed,
    rows: toWeekRowList(row.rows),
    conflictCount: row.conflict_count,
  }
}

/** The `p_rows` of `replace_week_hours`: exactly `weekday`, `start_time`, `end_time`. */
export type WeekRowArgs = { weekday: number; start_time: string; end_time: string }[]

export function toWeekRowArgs(rows: readonly WeekRow[]): WeekRowArgs {
  return rows.map((row) => ({
    weekday: row.weekday,
    start_time: row.startTime,
    end_time: row.endTime,
  }))
}

// ---------------------------------------------------------------------------------------------
// The StaffSheet form (React Hook Form + zodResolver). Keys follow the provisioning JSON
// (contract 1.6 §5.1); the ranges are the table CHECKs (0001).
// ---------------------------------------------------------------------------------------------

export const STAFF_NAME_MAX = 60
const COLOR = /^#[0-9A-Fa-f]{6}$/

export const StaffFormSchema = z.object({
  displayName: z.string().check(
    z.refine((name) => {
      const trimmed = name.trim()
      return trimmed.length > 0 && trimmed.length <= STAFF_NAME_MAX
    }, 'staffSettings.errors.name'),
  ),
  /** '' = «Χωρίς χρώμα». */
  color: z.string().check(z.refine((color) => color === '' || COLOR.test(color), 'errors.invalid')),
  active: z.boolean(),
})

export type StaffFormValues = z.infer<typeof StaffFormSchema>

export function toStaffForm(member: StaffMember | null, defaultColor: string): StaffFormValues {
  if (!member) return { displayName: '', color: defaultColor, active: true }
  return { displayName: member.displayName, color: member.color ?? '', active: member.active }
}

/** Expects a valid form; `sort` matters on create only. */
export function toStaffInput(form: StaffFormValues, id: string, sort: number): StaffInput {
  return {
    id,
    displayName: form.displayName.trim(),
    color: form.color === '' ? null : form.color,
    active: form.active,
    sort,
  }
}

/** The sort of a new staff member: after everyone else. */
export function nextStaffSort(staff: readonly StaffMember[]): number {
  return staff.reduce((max, member) => Math.max(max, member.sort), -1) + 1
}
