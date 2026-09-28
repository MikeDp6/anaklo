import { afterEach, describe, expect, it } from 'vitest'
import { injectBookingShell } from '../../../edge/inject.ts'
import { readInitialCatalogue } from './api'

const CATALOGUE = {
  business: {
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'demo-barber',
    name: 'Demo </script> "Barber"',
    vertical: 'barber',
    timezone: 'Europe/Athens',
    locale: 'el',
    currency: 'EUR',
    theme: { primary: '#1F3A5F' },
    address: null,
    maps_url: null,
    phone_e164: '+302610000000',
    min_notice_min: 60,
    max_advance_days: 60,
    allow_any_staff: true,
  },
  categories: [],
  services: [],
  staff: [],
}

function loadShell(initial: unknown) {
  const html = injectBookingShell(
    '<html lang="el"><head><title>x</title></head><body></body></html>',
    { title: 'x', initial },
  )
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    html,
    'text/html',
  ).documentElement.innerHTML
}

afterEach(() => {
  document.getElementById('anaklo-initial')?.remove()
})

describe('readInitialCatalogue', () => {
  it('reads the catalogue the Worker injected, surviving HTML-sensitive names', () => {
    loadShell({ catalogue: CATALOGUE })
    expect(readInitialCatalogue('demo-barber')).toEqual(CATALOGUE)
  })

  it('ignores data for another slug', () => {
    loadShell({ catalogue: CATALOGUE })
    expect(readInitialCatalogue('other-shop')).toBeUndefined()
  })

  it('ignores invalid data and a missing element', () => {
    expect(readInitialCatalogue('demo-barber')).toBeUndefined()
    loadShell({ catalogue: { ...CATALOGUE, business: { ...CATALOGUE.business, locale: 'xx' } } })
    expect(readInitialCatalogue('demo-barber')).toBeUndefined()
    const element = document.getElementById('anaklo-initial')
    if (element) element.textContent = '{not json'
    expect(readInitialCatalogue('demo-barber')).toBeUndefined()
  })
})
