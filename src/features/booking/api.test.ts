import { afterEach, describe, expect, it } from 'vitest'
import { injectBookingShell } from '../../../edge/inject.ts'
import { readInitialProfile } from './api'

const PROFILE = {
  slug: 'demo-barber',
  name: 'Demo </script> "Barber"',
  vertical: 'barber',
  timezone: 'Europe/Athens',
  locale: 'el',
  theme: { primary: '#1F3A5F' },
}

function loadShell(initial: unknown) {
  const html = injectBookingShell(
    '<html lang="el"><head><title>x</title></head><body></body></html>',
    {
      title: 'x',
      initial,
    },
  )
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    html,
    'text/html',
  ).documentElement.innerHTML
}

afterEach(() => {
  document.getElementById('anaklo-initial')?.remove()
})

describe('readInitialProfile', () => {
  it('reads the profile the Worker injected, surviving HTML-sensitive names', () => {
    loadShell({ profile: PROFILE })
    expect(readInitialProfile('demo-barber')).toEqual(PROFILE)
  })

  it('ignores data for another slug', () => {
    loadShell({ profile: PROFILE })
    expect(readInitialProfile('other-shop')).toBeUndefined()
  })

  it('ignores invalid data and a missing element', () => {
    expect(readInitialProfile('demo-barber')).toBeUndefined()
    loadShell({ profile: { ...PROFILE, locale: 'xx' } })
    expect(readInitialProfile('demo-barber')).toBeUndefined()
    const element = document.getElementById('anaklo-initial')
    if (element) element.textContent = '{not json'
    expect(readInitialProfile('demo-barber')).toBeUndefined()
  })
})
