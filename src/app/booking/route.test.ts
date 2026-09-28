import { describe, expect, it } from 'vitest'
import { isTrustedDeviceSpike, resolveBookingRoute } from './route'

const TOKEN = 'h578eKkJfn9LdGNVKSzs-_'

describe('resolveBookingRoute', () => {
  it('serves the landing page at /', () => {
    expect(resolveBookingRoute('/')).toEqual({ kind: 'landing' })
  })

  it.each([
    ['/demo-barber', 'demo-barber'],
    ['/demo-barber/', 'demo-barber'],
    ['/Demo-Barber', 'demo-barber'],
  ])('%s opens the booking page of %s', (path, slug) => {
    expect(resolveBookingRoute(path)).toEqual({ kind: 'business', slug })
  })

  it('opens the manage page for /m/<22-character token>, case kept', () => {
    expect(resolveBookingRoute(`/m/${TOKEN}`)).toEqual({ kind: 'manage', token: TOKEN })
    expect(resolveBookingRoute(`/m/${TOKEN}/`)).toEqual({ kind: 'manage', token: TOKEN })
  })

  it('resolves /r/<code> as a short link, in lower case', () => {
    expect(resolveBookingRoute('/r/demo01')).toEqual({ kind: 'short-link', code: 'demo01' })
    expect(resolveBookingRoute('/r/DEMO01')).toEqual({ kind: 'short-link', code: 'demo01' })
  })

  it.each([
    '/a',
    '/demo-barber/extra',
    '/κουρειο',
    '/-bad',
    '/bad-',
    '/m/short',
    `/m/${TOKEN}x`,
    '/m/h578eKkJfn9LdGNVKSzs+/',
    `/m/${TOKEN}/extra`,
    '/r/demo0',
    '/r/demo-1',
    '/r/demo012',
  ])('%s is not found', (path) => {
    expect(resolveBookingRoute(path)).toEqual({ kind: 'not-found' })
  })
})

describe('isTrustedDeviceSpike', () => {
  it('is on only for ?spike=td', () => {
    expect(isTrustedDeviceSpike('?spike=td')).toBe(true)
    expect(isTrustedDeviceSpike('?a=1&spike=td')).toBe(true)
    expect(isTrustedDeviceSpike('')).toBe(false)
    expect(isTrustedDeviceSpike('?spike=push')).toBe(false)
  })
})
