// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readableBrand } from '../src/shared/lib/theme.ts'
import type { FetchLike } from './api-proxy.ts'
import { lookupBookingShell } from './booking-shell.ts'

const ENV = {
  SUPABASE_URL: 'https://ref.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
}
const ROW = {
  slug: 'demo-barber',
  name: 'Demo Barber',
  vertical: 'barber',
  timezone: 'Europe/Athens',
  locale: 'en',
  theme: { primary: '#FFE14D' },
}

function answer(body: unknown, status = 200) {
  return vi.fn<FetchLike>(() => Promise.resolve(Response.json(body, { status })))
}

describe('lookupBookingShell', () => {
  it('builds the shell data from the profile, with the readable brand colour', async () => {
    const fetch = answer([ROW])
    const lookup = await lookupBookingShell('demo-barber', ENV, fetch, 'https://dev.anaklo.gr')
    expect(lookup).toEqual({
      kind: 'found',
      data: {
        title: 'Demo Barber',
        url: 'https://dev.anaklo.gr/demo-barber',
        themeColor: readableBrand('#FFE14D').background,
        lang: 'en',
        initial: { profile: ROW },
      },
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://ref.supabase.co/rest/v1/rpc/public_business_profile',
    )
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('has no theme colour or url when there is none', async () => {
    const lookup = await lookupBookingShell('demo-barber', ENV, answer([{ ...ROW, theme: {} }]))
    expect(lookup.kind === 'found' && lookup.data.themeColor).toBeUndefined()
    expect(lookup.kind === 'found' && lookup.data.url).toBeUndefined()
  })

  it('reports an unknown slug', async () => {
    expect(await lookupBookingShell('nope', ENV, answer([]))).toEqual({ kind: 'not-found' })
  })

  it.each([
    ['an error status', answer({ message: 'x' }, 500)],
    ['an unexpected shape', answer([{ slug: 1 }])],
    ['more than one row', answer([ROW, ROW])],
    ['a network error', vi.fn<FetchLike>(() => Promise.reject(new Error('timeout')))],
  ])('is unavailable on %s', async (_label, fetch) => {
    expect(await lookupBookingShell('demo-barber', ENV, fetch)).toEqual({ kind: 'unavailable' })
  })
})
