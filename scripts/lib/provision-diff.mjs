// Pure comparisons for provision-business.mjs: what must change so the database matches the file,
// and what the script refuses. No I/O here (Vitest: provision-diff.test.mjs).

/**
 * Columns the script may change on an existing business: the list the app itself may update
 * (`grant update (…) on public.businesses to authenticated`, 0001_foundation.sql), minus
 * `settings`, which provisioning does not manage.
 */
export const BUSINESS_UPDATABLE = /** @type {const} */ ([
  'name',
  'locale',
  'phone_e164',
  'booking_enabled',
  'slot_step_min',
  'min_notice_min',
  'max_advance_days',
  'cancel_min_notice_min',
  'auto_complete_after_min',
  'correction_window_days',
  'allow_any_staff',
  'theme',
  'messaging_enabled',
])

/**
 * Written only when the business is created (ADR-0009 §8); the slug is the lookup key. Later,
 * slug/timezone/currency change only through the owner's change_business_identity RPC (1.7) and
 * the vertical not at all in Phase 1.
 */
export const BUSINESS_CREATE_ONLY = /** @type {const} */ (['timezone', 'currency', 'vertical'])

/**
 * Deep equality for column values (jsonb objects compare without regard to key order, as
 * PostgreSQL stores them; undefined keys are ignored).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameValue(value, b[index]))
  }
  const left = /** @type {Record<string, unknown>} */ (a)
  const right = /** @type {Record<string, unknown>} */ (b)
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined)
  return keys.length === otherKeys.length && keys.every((key) => sameValue(left[key], right[key]))
}

/**
 * The columns of `desired` that differ from `existing`. Undefined in `desired` means "not in the
 * file": the column is left as it is.
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>} existing
 * @param {T} desired
 * @param {ReadonlyArray<keyof T & string>} columns
 * @returns {Partial<T>}
 */
export function patchFor(existing, desired, columns) {
  /** @type {Partial<T>} */
  const patch = {}
  for (const column of columns) {
    const value = desired[column]
    if (value !== undefined && !sameValue(existing[column], value)) patch[column] = value
  }
  return patch
}

/**
 * Messages for create-only columns that the file would change on an existing business.
 * @param {Record<string, unknown>} existing the database row
 * @param {{ timezone: string, currency: string, vertical: string }} desired
 * @returns {string[]}
 */
export function createOnlyConflicts(existing, desired) {
  return BUSINESS_CREATE_ONLY.flatMap((column) => {
    const current = String(existing[column] ?? '').trim()
    const wanted = desired[column]
    if (current === wanted) return []
    const how =
      column === 'vertical'
        ? 'The vertical does not change in Phase 1.'
        : 'It changes only through change_business_identity (owner, step 1.7).'
    return [
      `business.${column} is create-only: the database has "${current}", the file has "${wanted}". ${how} Fix the file.`,
    ]
  })
}

/**
 * "09:00" → "09:00:00" (PostgreSQL returns `time` with seconds); "09:00:00" stays as is.
 * @param {string} time
 */
export function toDbTime(time) {
  return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time
}

/** @typedef {{ weekday: number, start_time: string, end_time: string }} HoursRow */

/**
 * Whether two sets of weekly intervals are the same, whatever their order.
 * @param {readonly HoursRow[]} existing
 * @param {readonly HoursRow[]} desired
 */
export function sameHours(existing, desired) {
  /** @param {readonly HoursRow[]} rows */
  const signature = (rows) =>
    rows
      .map((row) => `${row.weekday} ${toDbTime(row.start_time)}-${toDbTime(row.end_time)}`)
      .sort()
      .join('|')
  return signature(existing) === signature(desired)
}

/**
 * @typedef {{ service_id: string, custom_duration_min: number | null, custom_price_cents: number | null }} StaffServiceRow
 */

/**
 * Rows to insert, update and remove so that ONE staff member offers exactly `desired`.
 * @param {readonly StaffServiceRow[]} existing
 * @param {readonly StaffServiceRow[]} desired
 */
export function diffStaffServices(existing, desired) {
  const current = new Map(existing.map((row) => [row.service_id, row]))
  const wanted = new Set(desired.map((row) => row.service_id))
  return {
    insert: desired.filter((row) => !current.has(row.service_id)),
    update: desired.filter((row) => {
      const before = current.get(row.service_id)
      return (
        before !== undefined &&
        (before.custom_duration_min !== row.custom_duration_min ||
          before.custom_price_cents !== row.custom_price_cents)
      )
    }),
    remove: existing.filter((row) => !wanted.has(row.service_id)).map((row) => row.service_id),
  }
}

/** @typedef {{ user_id: string, role: string, staff_id: string | null }} MemberRow */

/**
 * Memberships to insert or update. Members that are not in the file are only reported: the
 * script never removes access (that is the owner's decision, step 1.7).
 * @param {readonly MemberRow[]} existing
 * @param {readonly MemberRow[]} desired
 */
export function diffMembers(existing, desired) {
  const current = new Map(existing.map((row) => [row.user_id, row]))
  const wanted = new Set(desired.map((row) => row.user_id))
  return {
    insert: desired.filter((row) => !current.has(row.user_id)),
    update: desired.filter((row) => {
      const before = current.get(row.user_id)
      return before !== undefined && (before.role !== row.role || before.staff_id !== row.staff_id)
    }),
    notInFile: existing.filter((row) => !wanted.has(row.user_id)),
  }
}

/**
 * @typedef {object} DesiredLink
 * @property {string | null} user_id null for a login whose Auth user does not exist yet
 * @property {string | null} staff_id
 * @property {string | null} staffName
 */

/**
 * Staff members that two logins would hold once the file is applied
 * (business_members_staff_unique), checked against that FINAL state, for new users too, before
 * anything is written. Every login in the file ends with the staff member the file names (one
 * login per staff member, provision-schema.mjs), so only a login the file does not mention,
 * which keeps its current link, can collide. Moves inside the file (A leaves X, B or a new
 * login takes it) are fine: planMemberWrites orders them.
 * @param {readonly MemberRow[]} existing
 * @param {readonly DesiredLink[]} desired every login in the file
 * @param {(userId: string) => string} describeUser
 * @returns {string[]}
 */
export function staffLinkConflicts(existing, desired, describeUser) {
  const inFile = new Set(desired.flatMap((row) => (row.user_id === null ? [] : [row.user_id])))
  return desired.flatMap((row) => {
    if (row.staff_id === null) return []
    const holder = existing.find(
      (member) => member.staff_id === row.staff_id && !inFile.has(member.user_id),
    )
    if (!holder) return []
    return [
      `staff "${row.staffName}" is linked to the login ${describeUser(holder.user_id)}, which ` +
        'the file does not mention; unlink it first (or add that login to the file).',
    ]
  })
}

/**
 * @typedef {{ kind: 'insert', rows: MemberRow[] }
 *   | { kind: 'update', user_id: string, patch: { role?: string, staff_id?: string | null } }} MemberWrite
 */

/**
 * The membership writes, in an order where the state after EACH of them passes the constraints:
 * every PostgREST request is its own transaction, so the deferred owner check
 * (business_members_keep_owner, after update/delete) runs after each one, and the staff link
 * (business_members_staff_unique) is checked on every row.
 *
 * 1. new logins whose staff member nobody holds now (inserts never trip the owner check);
 * 2. promotions to owner (role only), so handing ownership over never leaves the business
 *    without one;
 * 3. logins whose staff member changes let go of it (staff_id null);
 * 4. new logins that take a staff member released in 3;
 * 5. what remains of each update, with the final role and staff (demotions included).
 *
 * Expects staffLinkConflicts to have found nothing.
 * @param {readonly MemberRow[]} existing
 * @param {readonly MemberRow[]} desired
 * @returns {MemberWrite[]}
 */
export function planMemberWrites(existing, desired) {
  const { insert, update } = diffMembers(existing, desired)
  /** @type {Map<string, MemberRow>} the state as the writes so far leave it */
  const now = new Map(existing.map((row) => [row.user_id, { ...row }]))
  /** @param {MemberRow} row */
  const stateOf = (row) => {
    const value = now.get(row.user_id)
    if (value === undefined) throw new Error(`internal: no member ${row.user_id}`)
    return value
  }
  const heldNow = new Set(existing.flatMap((row) => (row.staff_id === null ? [] : [row.staff_id])))
  const free = insert.filter((row) => row.staff_id === null || !heldNow.has(row.staff_id))
  const afterRelease = insert.filter((row) => !free.includes(row))

  /** @type {MemberWrite[]} */
  const writes = []
  if (free.length > 0) writes.push({ kind: 'insert', rows: free })
  for (const row of update) {
    const state = stateOf(row)
    if (row.role !== 'owner' || state.role === 'owner') continue
    writes.push({ kind: 'update', user_id: row.user_id, patch: { role: 'owner' } })
    state.role = 'owner'
  }
  for (const row of update) {
    const state = stateOf(row)
    if (state.staff_id === null || state.staff_id === row.staff_id) continue
    writes.push({ kind: 'update', user_id: row.user_id, patch: { staff_id: null } })
    state.staff_id = null
  }
  if (afterRelease.length > 0) writes.push({ kind: 'insert', rows: afterRelease })
  for (const row of update) {
    const state = stateOf(row)
    /** @type {{ role?: string, staff_id?: string | null }} */
    const patch = {}
    if (state.role !== row.role) patch.role = row.role
    if (state.staff_id !== row.staff_id) patch.staff_id = row.staff_id
    if (Object.keys(patch).length > 0) writes.push({ kind: 'update', user_id: row.user_id, patch })
  }
  return writes
}

/**
 * Database rows by name, the key the file uses. Duplicate names are reported only when the file
 * refers to that name (only then is the match ambiguous).
 * @template T
 * @param {readonly T[]} rows
 * @param {(row: T) => string} nameOf
 * @param {string} what e.g. "staff member"
 * @param {ReadonlySet<string>} referenced the names the file uses
 * @returns {{ byName: Map<string, T>, problems: string[], notInFile: string[] }}
 */
export function indexByName(rows, nameOf, what, referenced) {
  /** @type {Map<string, T>} */
  const byName = new Map()
  /** @type {Set<string>} */
  const ambiguous = new Set()
  for (const row of rows) {
    const name = nameOf(row)
    if (byName.has(name)) ambiguous.add(name)
    byName.set(name, row)
  }
  const problems = [...ambiguous]
    .filter((name) => referenced.has(name))
    .map((name) => `the database has more than one ${what} named "${name}"; rename one first.`)
  const notInFile = [...new Set(rows.map(nameOf))].filter((name) => !referenced.has(name))
  return { byName, problems, notInFile }
}
