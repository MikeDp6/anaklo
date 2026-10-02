import type { ScheduleConflict } from './schema'

/**
 * The rows a conflict list shows (contract 1.6 §4.9): the server's current rows, plus every row
 * resolved on this screen that the refetch no longer returns, so a result («Ανατέθηκε: …»,
 * «Ακυρώθηκε») stays on screen. A row that vanished without a result here (resolved elsewhere)
 * is gone. By start; rows starting together keep the server's order.
 */
export function withResolved(
  rows: readonly ScheduleConflict[],
  resolved: ReadonlyMap<string, ScheduleConflict>,
): ScheduleConflict[] {
  const current = new Set(rows.map((row) => row.appointmentId))
  const kept = [...resolved.values()].filter((row) => !current.has(row.appointmentId))
  return [...rows, ...kept].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
}

/** Every listed row has a result here (and there is at least one). */
export function allResolved(
  shown: readonly ScheduleConflict[],
  resolved: ReadonlyMap<string, ScheduleConflict>,
): boolean {
  return shown.length > 0 && shown.every((row) => resolved.has(row.appointmentId))
}
