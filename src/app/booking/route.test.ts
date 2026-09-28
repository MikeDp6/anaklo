import { describe, expect, it } from 'vitest'
import { isTrustedDeviceSpike, resolveBookingRoute } from './route'

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

  it.each(['/a', '/demo-barber/extra', '/κουρειο', '/-bad', '/bad-'])('%s is not found', (path) => {
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
