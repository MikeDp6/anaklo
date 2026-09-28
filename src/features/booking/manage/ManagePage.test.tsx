import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { testManageView } from '../testFixtures'
import ManagePage from './ManagePage'

const api = vi.hoisted(() => ({
  manageView: vi.fn(),
  manageSlots: vi.fn(),
  manageCancel: vi.fn(),
  manageReschedule: vi.fn(),
}))
vi.mock('./manageApi', () => api)

const TOKEN = 'h578eKkJfn9LdGNVKSzsuw'
const CLOSED = { can_cancel: false, can_reschedule: false }

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

beforeEach(() => {
  api.manageView.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function openAt(now: string) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(now) })
  render(<ManagePage token={TOKEN} />)
}

describe('ManagePage', () => {
  it('a completed appointment opened from an old SMS: no longer changeable, no call to the shop', async () => {
    api.manageView.mockResolvedValue({ ...testManageView({ status: 'completed' }), ...CLOSED })
    openAt('2026-10-08T12:00:00Z')
    expect(await screen.findByText('Δεν αλλάζει πια')).toBeInTheDocument()
    expect(screen.queryByText('Για αλλαγή ή ακύρωση τηλεφώνησε στο κατάστημα.')).toBeNull()
    expect(screen.queryByRole('link', { name: /^Τηλεφώνησε/ })).toBeNull()
  })

  it('a booked appointment already over is closed too', async () => {
    api.manageView.mockResolvedValue({ ...testManageView(), ...CLOSED })
    openAt('2026-10-01T07:00:00Z')
    expect(await screen.findByText('Δεν αλλάζει πια')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Τηλεφώνησε/ })).toBeNull()
  })

  it('inside the notice window of an appointment still ahead: call the shop', async () => {
    api.manageView.mockResolvedValue({ ...testManageView(), ...CLOSED })
    openAt('2026-10-01T05:00:00Z')
    expect(
      await screen.findByText('Για αλλαγή ή ακύρωση τηλεφώνησε στο κατάστημα.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Τηλεφώνησε/ })).toHaveAttribute(
      'href',
      'tel:+302610000000',
    )
  })
})
