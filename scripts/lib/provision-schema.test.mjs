// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findOverlaps, parseProvisionFile } from './provision-schema.mjs'

const EXAMPLE = new URL('../../supabase/provision/demo-barber.example.json', import.meta.url)

/** A fresh copy of the committed example, to modify per test. */
function example() {
  return JSON.parse(readFileSync(EXAMPLE, 'utf8'))
}

/** @param {unknown} input */
function errorsOf(input) {
  const result = parseProvisionFile(input)
  return result.ok ? [] : result.errors
}

/** @param {unknown} input */
function desiredOf(input) {
  const result = parseProvisionFile(input)
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.desired
}

describe('the committed example', () => {
  it('is valid and synthetic', () => {
    const desired = desiredOf(example())
    expect(desired.business.slug).toBe('demo-provision')
    expect(desired.members.map((member) => member.email).every((e) => e.endsWith('.test'))).toBe(
      true,
    )
  })
})

describe('findOverlaps', () => {
  it('allows back-to-back intervals', () => {
    expect(findOverlaps(['09:00-14:00', '14:00-18:00'])).toEqual([])
  })

  it('finds overlaps whatever the order', () => {
    expect(findOverlaps(['17:00-21:00', '09:00-14:00', '13:59-15:00'])).toEqual([[1, 2]])
  })

  it('finds an interval inside a longer one that is not the latest', () => {
    expect(findOverlaps(['09:00-20:00', '10:00-11:00', '12:00-13:00'])).toEqual([
      [0, 1],
      [0, 2],
    ])
  })

  it('treats identical intervals as overlapping', () => {
    expect(findOverlaps(['09:00-12:00', '09:00-12:00'])).toEqual([[0, 1]])
  })
})

describe('weekly hours', () => {
  it('rejects overlapping intervals of one staff member on one weekday', () => {
    const file = example()
    file.staff[0].hours.tue = ['09:00-14:00', '13:00-15:00']
    expect(errorsOf(file)).toEqual([
      'staff.0.hours.tue.1: "13:00-15:00" overlaps "09:00-14:00" (back-to-back is fine)',
    ])
  })

  it('accepts back-to-back intervals and the same interval on different days', () => {
    const file = example()
    file.staff[0].hours = { mon: ['09:00-12:00', '12:00-16:00'], tue: ['09:00-12:00'] }
    expect(errorsOf(file)).toEqual([])
  })

  it('does not compare different staff members', () => {
    const file = example()
    file.staff[0].hours = { sat: ['09:00-16:00'] }
    file.staff[1].hours = { sat: ['09:00-16:00'] }
    expect(errorsOf(file)).toEqual([])
  })

  it('rejects malformed, reversed and midnight-crossing intervals', () => {
    const file = example()
    file.staff[0].hours = { mon: ['9:00-14:00', '14:00-09:00', '22:00-24:00', '10:00-10:00'] }
    const errors = errorsOf(file)
    expect(errors).toHaveLength(4)
    expect(errors[0]).toMatch(/^staff\.0\.hours\.mon\.0: expected "HH:MM-HH:MM"/)
    expect(errors[1]).toMatch(/^staff\.0\.hours\.mon\.1: the end must be after the start/)
    expect(errors[2]).toMatch(/^staff\.0\.hours\.mon\.2: expected "HH:MM-HH:MM"/)
    expect(errors[3]).toMatch(/^staff\.0\.hours\.mon\.3: the end must be after the start/)
  })

  it('still finds overlaps among the well-formed intervals of a day with a malformed one', () => {
    const file = example()
    file.staff[0].hours = { mon: ['09:00-14:00', 'x', '13:00-15:00'] }
    expect(errorsOf(file)).toEqual([
      'staff.0.hours.mon.1: expected "HH:MM-HH:MM" in 24-hour local time, e.g. "09:00-14:00"',
      'staff.0.hours.mon.2: "13:00-15:00" overlaps "09:00-14:00" (back-to-back is fine)',
    ])
  })

  it('rejects unknown weekday keys', () => {
    const file = example()
    file.staff[0].hours = { monday: ['09:00-14:00'] }
    expect(errorsOf(file)).toEqual(['staff.0.hours: Unrecognized key: "monday"'])
  })

  it('becomes weekday rows (0 = Sunday), in local HH:MM', () => {
    const file = example()
    file.staff[0].hours = { sun: ['10:00-14:00'], mon: ['09:00-12:00', '13:00-17:00'] }
    expect(desiredOf(file).staff[0]?.hours).toEqual([
      { weekday: 1, start_time: '09:00', end_time: '12:00' },
      { weekday: 1, start_time: '13:00', end_time: '17:00' },
      { weekday: 0, start_time: '10:00', end_time: '14:00' },
    ])
  })

  it('leaves hours alone when omitted, and clears them when empty', () => {
    const file = example()
    delete file.staff[0].hours
    file.staff[1].hours = {}
    const desired = desiredOf(file)
    expect(desired.staff[0]?.hours).toBeUndefined()
    expect(desired.staff[1]?.hours).toEqual([])
  })
})

describe('business', () => {
  it('normalises the phone to E.164 and keeps omitted fields undefined', () => {
    const file = example()
    file.business.phone = '261 000 0001'
    delete file.business.booking_enabled
    delete file.business.policy
    const { business } = desiredOf(file)
    expect(business.phone_e164).toBe('+302610000001')
    expect(business).not.toHaveProperty('booking_enabled')
    expect(business).not.toHaveProperty('slot_step_min')
  })

  it('clears the phone with null', () => {
    const file = example()
    file.business.phone = null
    expect(desiredOf(file).business.phone_e164).toBeNull()
  })

  it('rejects offsets and unknown zones, bad slugs, currencies and phones', () => {
    const file = example()
    file.business.timezone = 'UTC+2'
    file.business.slug = 'Demo_Barber'
    file.business.currency = 'eur'
    file.business.phone = '12345'
    expect(errorsOf(file)).toEqual([
      'business.slug: expected 3–40 characters: a-z, 0-9 and "-", not starting or ending with "-"',
      'business.timezone: expected an IANA Area/Location time zone name',
      'business.currency: expected an ISO 4217 code such as EUR',
      'business.phone: not a valid phone number',
    ])
    file.business.timezone = 'Europe/Atlantis'
    expect(errorsOf(file)).toContain('business.timezone: unknown time zone')
  })

  it('rejects unknown keys (a typo must not be silently ignored)', () => {
    const file = example()
    file.business.boking_enabled = true
    expect(errorsOf(file)).toEqual(['business: Unrecognized key: "boking_enabled"'])
  })

  it('carries the address, the map link, the quiet hours and the reminder mode (1.6 §2.9)', () => {
    const { business } = desiredOf(example())
    expect(business).toMatchObject({
      address: 'Οδός Παραδείγματος 1, Πάτρα',
      quiet_start: '22:00',
      quiet_end: '09:00',
      reminder_mode: '24h',
    })
    expect(business).not.toHaveProperty('maps_url')

    const file = example()
    file.business.address = null
    file.business.maps_url = 'https://maps.example.test/demo'
    expect(desiredOf(file).business).toMatchObject({
      address: null,
      maps_url: 'https://maps.example.test/demo',
    })
  })

  it('rejects a non-https map link, a long address, bad quiet hours and an unknown mode', () => {
    const file = example()
    file.business.maps_url = 'http://maps.example.test/demo'
    file.business.address = 'x'.repeat(201)
    file.business.policy.quiet_start = '22:00:00'
    file.business.policy.quiet_end = '9:00'
    file.business.policy.reminder_mode = 'hour_before'
    const errors = errorsOf(file)
    expect(errors).toHaveLength(5)
    expect(errors[0]).toMatch(/^business\.address: /)
    expect(errors[1]).toBe('business.maps_url: expected an https:// link')
    expect(errors[2]).toBe('business.policy.quiet_start: expected "HH:MM"')
    expect(errors[3]).toBe('business.policy.quiet_end: expected "HH:MM"')
    expect(errors[4]).toMatch(/^business\.policy\.reminder_mode: /)
  })

  it('flattens the policy into columns', () => {
    const file = example()
    file.business.policy = { slot_step_min: 30, allow_any_staff: false }
    const { business } = desiredOf(file)
    expect(business.slot_step_min).toBe(30)
    expect(business.allow_any_staff).toBe(false)
    expect(business).not.toHaveProperty('min_notice_min')
  })
})

describe('catalogue and staff', () => {
  it('rejects duplicates and unknown references', () => {
    const file = example()
    file.categories.push({ name: 'Μαλλιά' })
    file.services[3].category = 'Χρώμα'
    file.services.push({ ...file.services[0] })
    file.staff[1].services = ['Κούρεμα', 'Κούρεμα', 'Ξύρισμα']
    file.staff[2].display_name = 'Σταύρος'
    expect(errorsOf(file)).toEqual([
      'categories.2.name: duplicate category "Μαλλιά"',
      'services.4.name: duplicate service "Κούρεμα"',
      'services.3.category: unknown category "Χρώμα"',
      'staff.2.display_name: duplicate staff member "Σταύρος"',
      'staff.1.services.2: unknown service "Ξύρισμα"',
      'staff.1.services.1: service "Κούρεμα" is listed twice',
    ])
  })

  it('rejects fractional cents', () => {
    const file = example()
    file.services[0].price_cents = 13.5
    expect(errorsOf(file)).toEqual([
      'services.0.price_cents: Invalid input: expected int, received number',
    ])
  })

  it('expands "all", accepts names and objects, and defaults sort to the position', () => {
    const desired = desiredOf(example())
    const [owner, barber] = desired.staff
    expect(owner?.services?.map((entry) => entry.service)).toEqual(
      desired.services.map((service) => service.name),
    )
    expect(barber?.services?.[0]).toEqual({
      service: 'Κούρεμα',
      custom_duration_min: 35,
      custom_price_cents: null,
    })
    expect(barber?.services?.[1]).toEqual({
      service: 'Κούρεμα + γένια',
      custom_duration_min: null,
      custom_price_cents: null,
    })
    expect(desired.staff.map((person) => person.sort)).toEqual([0, 1, 2])
    expect(desired.services[2]?.category).toBe('Γένια')
  })
})

describe('logins', () => {
  it('lower-cases emails and links staff logins to their staff member', () => {
    const file = example()
    file.staff[0].login.email = 'Owner@Demo-Provision.TEST'
    const desired = desiredOf(file)
    expect(desired.members).toEqual([
      { email: 'owner@demo-provision.test', role: 'owner', staff: 'Σταύρος' },
      { email: 'barber@demo-provision.test', role: 'staff', staff: 'Μάριος' },
      { email: 'manager@demo-provision.test', role: 'manager', staff: null },
    ])
  })

  it('requires an owner', () => {
    const file = example()
    file.staff[0].login.role = 'manager'
    expect(errorsOf(file)).toEqual([
      'staff: at least one login (staff[].login or members[]) must have role "owner"',
    ])
  })

  it('rejects an email used twice, whatever its case', () => {
    const file = example()
    file.members.push({ email: 'OWNER@demo-provision.test', role: 'manager' })
    expect(errorsOf(file)).toEqual([
      'members.1.email: email owner@demo-provision.test is used twice',
    ])
  })

  it('rejects unknown roles and invalid emails', () => {
    const file = example()
    file.members[0] = { email: 'not-an-email', role: 'admin' }
    const errors = errorsOf(file)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/^members\.0\.email: /)
    expect(errors[1]).toMatch(/^members\.0\.role: /)
  })
})
