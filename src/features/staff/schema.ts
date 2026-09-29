import { z } from 'zod/mini'
import { Id } from '@fn-shared/booking-schemas.ts'

export const StaffRows = z.array(
  z.object({
    id: Id,
    display_name: z.string(),
    color: z.nullable(z.string()),
    sort: z.int(),
    active: z.boolean(),
  }),
)

export interface StaffMember {
  readonly id: string
  readonly displayName: string
  readonly color: string | null
  readonly sort: number
  readonly active: boolean
}

export function toStaff(rows: z.infer<typeof StaffRows>): StaffMember[] {
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    sort: row.sort,
    active: row.active,
  }))
}

/** `id → display name`, also for inactive staff (old appointments keep their staff member). */
export function staffNames(staff: readonly StaffMember[]): ReadonlyMap<string, string> {
  return new Map(staff.map((member) => [member.id, member.displayName]))
}
