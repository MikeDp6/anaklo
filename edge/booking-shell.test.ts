// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import elBooking from '../src/shared/i18n/el/booking.json'
import { readableBrand } from '../src/shared/lib/theme.ts'
import type { FetchLike } from './api-proxy.ts'
import { lookupBookingShell, lookupShortLink, shareDescription } from './booking-shell.ts'

const ENV = {
  SUPABASE_URL: 'https://ref.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
}
const CATALOGUE = {
  business: {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'demo-barber',
    name: 'Demo Barber',
    vertical: 'barber',
    timezone: 'Europe/Athens',
    locale: 'en',
    theme: { primary: '#FFE14D' },
  },
  categories: [],
  services: [],
  staff: [],
}

function answer(body: unknown, status = 200) {
  return vi.fn<FetchLike>(() => Promise.resolve(Response.json(body, { status })))
}

describe('lookupBookingShell', () => {
  it('builds the shell data from the catalogue, with the readable brand colour', async () => {
    const fetch = answer(CATALOGUE)
    const lookup = await lookupBookingShell('demo-barber', ENV, fetch, 'https://dev.anaklo.gr')
    expect(lookup).toEqual({
      kind: 'found',
      data: {
        title: 'Demo Barber',
        description: 'Book online at Demo Barber.',
        url: 'https://dev.anaklo.gr/demo-barber',
        themeColor: readableBrand('#FFE14D').background,
        lang: 'en',
        initial: { catalogue: CATALOGUE },
      },
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://ref.supabase.co/rest/v1/rpc/public_booking_catalogue',
    )
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"p_slug":"demo-barber"}')
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('has no theme colour or url when there is none', async () => {
    const business = { ...CATALOGUE.business, theme: {} }
    const lookup = await lookupBookingShell('demo-barber', ENV, answer({ ...CATALOGUE, business }))
    expect(lookup.kind === 'found' && lookup.data.themeColor).toBeUndefined()
    expect(lookup.kind === 'found' && lookup.data.url).toBeUndefined()
  })

  it('reports a former slug as moved to the current one (contract 1.7 §4)', async () => {
    const fetch = answer(CATALOGUE)
    expect(await lookupBookingShell('old-barber', ENV, fetch)).toEqual({
      kind: 'moved',
      slug: 'demo-barber',
    })
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"p_slug":"old-barber"}')
    // The requested slug compares lower-cased.
    expect((await lookupBookingShell('Demo-Barber', ENV, answer(CATALOGUE))).kind).toBe('found')
  })

  it.each(['//evil.example', 'Demo Barber', '', 'a'])(
    'is unavailable when the current slug %j is not a slug',
    async (slug) => {
      const business = { ...CATALOGUE.business, slug }
      const lookup = await lookupBookingShell('old-barber', ENV, answer({ ...CATALOGUE, business }))
      expect(lookup).toEqual({ kind: 'unavailable' })
    },
  )

  it('reports an unknown slug or a business with booking off (null)', async () => {
    expect(await lookupBookingShell('nope', ENV, answer(null))).toEqual({ kind: 'not-found' })
  })

  it.each([
    ['an error status', answer({ message: 'x' }, 500)],
    ['an unexpected shape', answer({ business: { slug: 1 } })],
    ['a network error', vi.fn<FetchLike>(() => Promise.reject(new Error('timeout')))],
  ])('is unavailable on %s', async (_label, fetch) => {
    expect(await lookupBookingShell('demo-barber', ENV, fetch)).toEqual({ kind: 'unavailable' })
  })
})

describe('shareDescription', () => {
  it('uses the booking catalogue of the business language, Greek otherwise', () => {
    expect(shareDescription('el', 'Κουρείο $& Σία')).toBe(
      elBooking.og.description.replace('{{name}}', () => 'Κουρείο $& Σία'),
    )
    expect(shareDescription('xx', 'A')).toBe(shareDescription('el', 'A'))
  })
})

describe('lookupShortLink', () => {
  it('resolves a code to the slug with the publishable key', async () => {
    const fetch = answer('demo-barber')
    expect(await lookupShortLink('demo01', ENV, fetch)).toEqual({
      kind: 'found',
      slug: 'demo-barber',
    })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe('https://ref.supabase.co/rest/v1/rpc/public_slug_for_code')
    expect(init?.body).toBe('{"p_code":"demo01"}')
    expect(new Headers(init?.headers).get('apikey')).toBe('sb_publishable_x')
  })

  it('is not found for an unknown code or a closed business', async () => {
    expect(await lookupShortLink('zzzzzz', ENV, answer(null))).toEqual({ kind: 'not-found' })
  })

  it.each([
    ['an error status', answer({ message: 'x' }, 500)],
    ['a slug that is not one', answer('//evil.example')],
    ['a network error', vi.fn<FetchLike>(() => Promise.reject(new Error('down')))],
  ])('is unavailable on %s', async (_label, fetch) => {
    expect(await lookupShortLink('demo01', ENV, fetch)).toEqual({ kind: 'unavailable' })
  })
})
