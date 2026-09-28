/**
 * «Add to calendar» after a booking (phase 1 §1.3): a Google Calendar link and an .ics file.
 * Both use UTC instants (no zone guessing on the visitor's device); the texts come from the
 * `booking` namespace. Pure: the caller turns the .ics text into a download.
 */

export interface CalendarEvent {
  /** Stable id of the event (the appointment id): re-importing updates instead of duplicating. */
  uid: string
  title: string
  description: string
  location: string | null
  start: Date
  end: Date
}

/** `20261001T060000Z` */
export function utcStamp(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${utcStamp(event.start)}/${utcStamp(event.end)}`,
    details: event.description,
  })
  if (event.location) params.set('location', event.location)
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and line breaks are escaped in TEXT values. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

const encoder = new TextEncoder()
const MAX_LINE_OCTETS = 75

/** RFC 5545 §3.1: lines longer than 75 octets fold with CRLF + space, never inside a character. */
export function foldIcsLine(line: string): string {
  const parts: string[] = []
  let current = ''
  let octets = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    const limit = parts.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1
    if (octets + size > limit) {
      parts.push(current)
      current = ''
      octets = 0
    }
    current += char
    octets += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

export function buildIcs(event: CalendarEvent, now: Date, prodId: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(event.start)}`,
    `DTEND:${utcStamp(event.end)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    ...(event.location ? [`LOCATION:${escapeIcsText(event.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`
}
