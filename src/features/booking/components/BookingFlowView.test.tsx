import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { TEST_SLOT, testCatalogue } from '../testFixtures'
import { BookingFlowView } from './BookingFlowView'

const api = vi.hoisted(() => ({ fetchSlots: vi.fn(), forgetSlots: vi.fn() }))
vi.mock('../api', () => api)
// The chunk of the steps after the slot cannot be fetched: every lazy step rejects, as
// React.lazy sees a failed dynamic import.
vi.mock('./laterSteps', async () => {
  const { lazy } = await import('react')
  const missing = () =>
    lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))
  return {
    prefetchLaterSteps: () => undefined,
    DetailsStep: missing(),
    OtpStep: missing(),
    ClientChoiceStep: missing(),
    ConfirmStep: missing(),
  }
})

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BookingFlowView', () => {
  it('when the later steps do not load: a notice with a retry and the shop phone, the header stays', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-30T08:00:00Z') })
    api.fetchSlots.mockResolvedValue([TEST_SLOT])
    const catalogue = testCatalogue()
    catalogue.business.phone_e164 = '+302610000000'
    render(<BookingFlowView catalogue={catalogue} />)

    screen.getByRole('button', { name: /^Κούρεμα/ }).click()
    ;(await screen.findByRole('button', { name: '09:00' })).click()

    expect(await screen.findByRole('heading', { name: 'Δεν φόρτωσε η σελίδα' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Δοκίμασε ξανά' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Τηλεφώνησε/ })).toHaveAttribute(
      'href',
      'tel:+302610000000',
    )
    // «Back» still works: the slot step belongs to the main chunk.
    screen.getByRole('button', { name: 'Πίσω' }).click()
    expect(await screen.findByRole('button', { name: '09:00' })).toBeInTheDocument()
  })
})
