import { describe, expect, it } from 'vitest'
import {
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  utcStamp,
  type CalendarEvent,
} from './calendar'

// Texts here are test data; the page takes them from the `booking` namespace.
const EVENT: CalendarEvent = {
  uid: '58238d55-f2e5-4309-80a4-0a75a011a7a8@anaklo',
  title: 'Κούρεμα, Demo Barber',
  description: 'Αλλαγή ή ακύρωση: http://localhost:5173/m/h578eKkJfn9LdGNVKSzsuw',
  location: 'Ερμού 1; Αθήνα',
  start: new Date('2026-10-01T06:00:00+00:00'),
  end: new Date('2026-10-01T06:30:00+00:00'),
}

describe('utcStamp', () => {
  it('prints a UTC instant as yyyyMMddTHHmmssZ, whatever the device zone', () => {
    expect(utcStamp(new Date('2026-10-25T00:30:00+03:00'))).toBe('20261024T213000Z')
  })
})

describe('googleCalendarUrl', () => {
  it('builds a TEMPLATE link with UTC dates and encoded texts', () => {
    const url = new URL(googleCalendarUrl(EVENT))
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('action')).toBe('TEMPLATE')
    expect(url.searchParams.get('dates')).toBe('20261001T060000Z/20261001T063000Z')
    expect(url.searchParams.get('text')).toBe(EVENT.title)
    expect(url.searchParams.get('details')).toBe(EVENT.description)
    expect(url.searchParams.get('location')).toBe(EVENT.location)
  })

  it('leaves out an unknown location', () => {
    const url = new URL(googleCalendarUrl({ ...EVENT, location: null }))
    expect(url.searchParams.has('location')).toBe(false)
  })
})

describe('.ics', () => {
  it('escapes backslash, semicolon, comma and line breaks', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf')
  })

  it('folds at 75 octets without splitting a Greek character', () => {
    const line = `SUMMARY:${'Κούρεμα '.repeat(12)}`
    const folded = foldIcsLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (const [index, part] of parts.entries()) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
      if (index > 0) expect(part.startsWith(' ')).toBe(true)
    }
    expect(parts.map((part, index) => (index > 0 ? part.slice(1) : part)).join('')).toBe(line)
  })

  it('is a CRLF VCALENDAR with one UTC event', () => {
    const ics = buildIcs(EVENT, new Date('2026-09-28T13:00:00Z'), '-//Anaklo//Booking//EL')
    expect(ics.endsWith('\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    const lines = ics.replace(/\r\n /g, '').split('\r\n')
    expect(lines).toContain('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('PRODID:-//Anaklo//Booking//EL')
    expect(lines).toContain(`UID:${EVENT.uid}`)
    expect(lines).toContain('DTSTAMP:20260928T130000Z')
    expect(lines).toContain('DTSTART:20261001T060000Z')
    expect(lines).toContain('DTEND:20261001T063000Z')
    expect(lines).toContain('SUMMARY:Κούρεμα\\, Demo Barber')
    expect(lines).toContain('LOCATION:Ερμού 1\\; Αθήνα')
    expect(lines.at(-2)).toBe('END:VCALENDAR')
  })

  it('has no LOCATION when the business has no address', () => {
    const ics = buildIcs({ ...EVENT, location: null }, new Date(), '-//Anaklo//Booking//EL')
    expect(ics).not.toContain('LOCATION:')
  })
})
