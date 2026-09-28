// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_UPDATABLE,
  createOnlyConflicts,
  diffMembers,
  diffStaffServices,
  indexByName,
  patchFor,
  planMemberWrites,
  sameHours,
  sameValue,
  staffLinkConflicts,
  toDbTime,
} from './provision-diff.mjs'

const ZONE = 'Europe/Athens'
const OTHER_ZONE = 'Europe/Berlin'

describe('sameValue', () => {
  it('compares jsonb objects without regard to key order', () => {
    expect(sameValue({ primary: '#111111', radius: 12 }, { radius: 12, primary: '#111111' })).toBe(
      true,
    )
    expect(sameValue({ radius: 12 }, { radius: 16 })).toBe(false)
    expect(sameValue({ radius: 12 }, { radius: 12, font: 'manrope' })).toBe(false)
    expect(sameValue({}, {})).toBe(true)
  })

  it('treats null, arrays and primitives strictly', () => {
    expect(sameValue(null, null)).toBe(true)
    expect(sameValue(null, {})).toBe(false)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue(15, '15')).toBe(false)
  })
})

describe('patchFor', () => {
  const existing = { name: 'Old', locale: 'el', phone_e164: '+302610000000', theme: { radius: 12 } }

  it('keeps only the columns that differ', () => {
    expect(
      patchFor(existing, { name: 'New', locale: 'el', theme: { radius: 12 } }, [
        'name',
        'locale',
        'theme',
      ]),
    ).toEqual({ name: 'New' })
  })

  it('leaves columns that the file omits (undefined), but writes null', () => {
    expect(
      patchFor(existing, { name: undefined, phone_e164: null }, ['name', 'phone_e164']),
    ).toEqual({ phone_e164: null })
  })

  it('never includes the create-only columns in the business update list', () => {
    for (const column of ['slug', 'timezone', 'currency', 'vertical', 'id', 'settings']) {
      expect(BUSINESS_UPDATABLE).not.toContain(column)
    }
  })
})

describe('createOnlyConflicts', () => {
  const existing = { slug: 'demo', timezone: ZONE, currency: 'EUR', vertical: 'barber' }

  it('accepts an unchanged identity', () => {
    expect(
      createOnlyConflicts(existing, { timezone: ZONE, currency: 'EUR', vertical: 'barber' }),
    ).toEqual([])
  })

  it('refuses a changed timezone, currency or vertical with a clear message', () => {
    const conflicts = createOnlyConflicts(existing, {
      timezone: OTHER_ZONE,
      currency: 'USD',
      vertical: 'beauty',
    })
    expect(conflicts).toHaveLength(3)
    expect(conflicts[0]).toBe(
      `business.timezone is create-only: the database has "${ZONE}", the file has "${OTHER_ZONE}". ` +
        'It changes only through change_business_identity (owner, step 1.7). Fix the file.',
    )
    expect(conflicts[2]).toMatch(/vertical does not change in Phase 1/)
  })
})

describe('working hours', () => {
  it('normalises HH:MM to the database time format', () => {
    expect(toDbTime('09:00')).toBe('09:00:00')
    expect(toDbTime('09:00:00')).toBe('09:00:00')
  })

  it('compares sets of intervals whatever the order and format', () => {
    const db = [
      { weekday: 2, start_time: '17:00:00', end_time: '21:00:00' },
      { weekday: 2, start_time: '09:00:00', end_time: '14:00:00' },
    ]
    const file = [
      { weekday: 2, start_time: '09:00', end_time: '14:00' },
      { weekday: 2, start_time: '17:00', end_time: '21:00' },
    ]
    expect(sameHours(db, file)).toBe(true)
    expect(sameHours(db, file.slice(0, 1))).toBe(false)
    expect(
      sameHours(db, [...file.slice(0, 1), { weekday: 3, start_time: '17:00', end_time: '21:00' }]),
    ).toBe(false)
    expect(sameHours([], [])).toBe(true)
  })
})

describe('diffStaffServices', () => {
  it('inserts, updates and removes to match the file', () => {
    const existing = [
      { service_id: 'a', custom_duration_min: null, custom_price_cents: null },
      { service_id: 'b', custom_duration_min: 35, custom_price_cents: null },
      { service_id: 'c', custom_duration_min: null, custom_price_cents: null },
    ]
    const desired = [
      { service_id: 'a', custom_duration_min: null, custom_price_cents: null },
      { service_id: 'b', custom_duration_min: 40, custom_price_cents: null },
      { service_id: 'd', custom_duration_min: null, custom_price_cents: 900 },
    ]
    expect(diffStaffServices(existing, desired)).toEqual({
      insert: [desired[2]],
      update: [desired[1]],
      remove: ['c'],
    })
    expect(diffStaffServices(desired, desired)).toEqual({ insert: [], update: [], remove: [] })
  })
})

describe('diffMembers', () => {
  it('inserts and updates, and only reports members missing from the file', () => {
    const existing = [
      { user_id: 'u1', role: 'owner', staff_id: 's1' },
      { user_id: 'u2', role: 'staff', staff_id: 's2' },
      { user_id: 'u9', role: 'manager', staff_id: null },
    ]
    const desired = [
      { user_id: 'u1', role: 'owner', staff_id: 's1' },
      { user_id: 'u2', role: 'manager', staff_id: 's2' },
      { user_id: 'u3', role: 'staff', staff_id: 's3' },
    ]
    expect(diffMembers(existing, desired)).toEqual({
      insert: [desired[2]],
      update: [desired[1]],
      notInFile: [existing[2]],
    })
  })
})

describe('staffLinkConflicts (final state, before any write)', () => {
  const existing = [{ user_id: 'u1', role: 'staff', staff_id: 's1' }]
  const describeUser = (/** @type {string} */ id) => `${id}@example.test`
  const refusal =
    'staff "Νίκος" is linked to the login u1@example.test, which the file does not mention; ' +
    'unlink it first (or add that login to the file).'

  it('refuses a staff member that a login outside the file keeps', () => {
    const desired = [{ user_id: 'u2', staff_id: 's1', staffName: 'Νίκος' }]
    expect(staffLinkConflicts(existing, desired, describeUser)).toEqual([refusal])
  })

  it('checks logins whose Auth user does not exist yet as well', () => {
    const desired = [{ user_id: null, staff_id: 's1', staffName: 'Νίκος' }]
    expect(staffLinkConflicts(existing, desired, describeUser)).toEqual([refusal])
  })

  it('accepts moves inside the file: the holder is in the file with another staff member', () => {
    const desired = [
      { user_id: 'u1', staff_id: 's2', staffName: 'Άλεξ' },
      { user_id: null, staff_id: 's1', staffName: 'Νίκος' },
    ]
    expect(staffLinkConflicts(existing, desired, describeUser)).toEqual([])
    expect(
      staffLinkConflicts(existing, [{ user_id: 'u1', staff_id: 's1', staffName: 'Νίκος' }], String),
    ).toEqual([])
  })
})

/**
 * Applies the writes one request at a time with the database's rules: the unique staff link on
 * every row, and (deferred to the end of each request) an owner after any update.
 * @param {ReadonlyArray<{ user_id: string, role: string, staff_id: string | null }>} existing
 * @param {ReturnType<typeof planMemberWrites>} writes
 */
function applyWrites(existing, writes) {
  const table = new Map(existing.map((row) => [row.user_id, { ...row }]))
  const checkStaff = () => {
    const links = [...table.values()].flatMap((row) => (row.staff_id ? [row.staff_id] : []))
    if (new Set(links).size !== links.length) throw new Error('business_members_staff_unique')
  }
  for (const write of writes) {
    if (write.kind === 'insert') {
      for (const row of write.rows) {
        table.set(row.user_id, { ...row })
        checkStaff()
      }
      continue
    }
    const row = table.get(write.user_id)
    if (!row) throw new Error(`no member ${write.user_id}`)
    Object.assign(row, write.patch)
    checkStaff()
    if (![...table.values()].some((member) => member.role === 'owner')) {
      throw new Error('business would be left without an owner')
    }
  }
  return [...table.values()].sort((a, b) => a.user_id.localeCompare(b.user_id))
}

/** @param {ReadonlyArray<{ user_id: string }>} rows */
const sorted = (rows) => [...rows].sort((a, b) => a.user_id.localeCompare(b.user_id))

describe('planMemberWrites', () => {
  it('hands ownership over (A owner → manager, B manager → owner) without an ownerless step', () => {
    const existing = [
      { user_id: 'a', role: 'owner', staff_id: 'nikos' },
      { user_id: 'b', role: 'manager', staff_id: null },
    ]
    // File order: staff logins before members[], so A comes first.
    const desired = [
      { user_id: 'a', role: 'manager', staff_id: 'nikos' },
      { user_id: 'b', role: 'owner', staff_id: null },
    ]
    const writes = planMemberWrites(existing, desired)
    expect(writes).toEqual([
      { kind: 'update', user_id: 'b', patch: { role: 'owner' } },
      { kind: 'update', user_id: 'a', patch: { role: 'manager' } },
    ])
    expect(applyWrites(existing, writes)).toEqual(sorted(desired))
  })

  it('moves a staff member to a NEW login after its old login lets go of it', () => {
    const existing = [
      { user_id: 'owner', role: 'owner', staff_id: null },
      { user_id: 'a', role: 'staff', staff_id: 'x' },
    ]
    const desired = [
      { user_id: 'owner', role: 'owner', staff_id: null },
      { user_id: 'a', role: 'staff', staff_id: 'y' },
      { user_id: 'c', role: 'staff', staff_id: 'x' },
    ]
    const writes = planMemberWrites(existing, desired)
    expect(writes).toEqual([
      { kind: 'update', user_id: 'a', patch: { staff_id: null } },
      { kind: 'insert', rows: [{ user_id: 'c', role: 'staff', staff_id: 'x' }] },
      { kind: 'update', user_id: 'a', patch: { staff_id: 'y' } },
    ])
    expect(applyWrites(existing, writes)).toEqual(sorted(desired))
  })

  it('swaps two staff members between logins, and hands over both role and staff at once', () => {
    const existing = [
      { user_id: 'a', role: 'owner', staff_id: 'x' },
      { user_id: 'b', role: 'staff', staff_id: 'y' },
    ]
    const desired = [
      { user_id: 'a', role: 'staff', staff_id: 'y' },
      { user_id: 'b', role: 'owner', staff_id: 'x' },
    ]
    expect(applyWrites(existing, planMemberWrites(existing, desired))).toEqual(sorted(desired))
  })

  it('a new owner who takes the old owner’s staff member', () => {
    const existing = [{ user_id: 'a', role: 'owner', staff_id: 'x' }]
    const desired = [
      { user_id: 'a', role: 'manager', staff_id: null },
      { user_id: 'n', role: 'owner', staff_id: 'x' },
    ]
    expect(applyWrites(existing, planMemberWrites(existing, desired))).toEqual(sorted(desired))
  })

  it('inserts first when nothing is held, and writes nothing when nothing differs', () => {
    const desired = [
      { user_id: 'o', role: 'owner', staff_id: 'x' },
      { user_id: 'm', role: 'manager', staff_id: null },
    ]
    expect(planMemberWrites([], desired)).toEqual([{ kind: 'insert', rows: desired }])
    expect(planMemberWrites(desired, desired)).toEqual([])
  })
})

describe('indexByName', () => {
  const rows = [
    { id: '1', name: 'Κούρεμα' },
    { id: '2', name: 'Κούρεμα' },
    { id: '3', name: 'Γένια' },
    { id: '4', name: 'Παλιό' },
  ]

  it('reports duplicate names only when the file uses them', () => {
    expect(indexByName(rows, (row) => row.name, 'service', new Set(['Γένια'])).problems).toEqual([])
    expect(indexByName(rows, (row) => row.name, 'service', new Set(['Κούρεμα'])).problems).toEqual([
      'the database has more than one service named "Κούρεμα"; rename one first.',
    ])
  })

  it('lists the names the file does not mention', () => {
    const index = indexByName(rows, (row) => row.name, 'service', new Set(['Κούρεμα', 'Γένια']))
    expect(index.notInFile).toEqual(['Παλιό'])
    expect(index.byName.get('Γένια')?.id).toBe('3')
  })
})
