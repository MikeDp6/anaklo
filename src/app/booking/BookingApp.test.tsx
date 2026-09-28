import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { BookingApp } from './BookingApp'

// The manage link's chunk cannot be fetched (flaky network, or gone after a deploy).
vi.mock('@/features/booking/manage/ManagePage', () => {
  throw new TypeError('Failed to fetch dynamically imported module')
})
// Had the page loaded, it would have asked for its appointment.
const api = vi.hoisted(() => ({ manageView: vi.fn() }))
vi.mock('@/features/booking/manage/manageApi', () => api)

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

afterEach(() => {
  cleanup()
})

describe('BookingApp', () => {
  it('a manage link whose chunk does not load shows a notice with a retry, not a blank page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<BookingApp route={{ kind: 'manage', token: 'h578eKkJfn9LdGNVKSzsuw' }} />)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Δεν φόρτωσε η σελίδα' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Δοκίμασε ξανά' })).toBeInTheDocument()
    expect(api.manageView).not.toHaveBeenCalled()
  })
})
