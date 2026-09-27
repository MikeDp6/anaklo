import { describe, expect, it } from 'vitest'
import { resolveBookingRoute } from './route'

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
