import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManageSlot } from '@fn-shared/booking-schemas.ts'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { testManageView } from '../testFixtures'
import { RescheduleView } from './RescheduleView'

const api = vi.hoisted(() => ({
  manageView: vi.fn(),
  manageSlots: vi.fn(),
  manageCancel: vi.fn(),
  manageReschedule: vi.fn(),
}))
vi.mock('./manageApi', () => api)

const TOKEN = 'h578eKkJfn9LdGNVKSzsuw'
// The appointment is Thu 1 Oct 09:00 (Athens); these are the other free starts.
const THU_0930: ManageSlot = {
  starts_at: '2026-10-01T06:30:00+00:00',
  local_date: '2026-10-01',
  local_time: '09:30:00',
}
const FRI_1000: ManageSlot = {
  starts_at: '2026-10-02T07:00:00+00:00',
  local_date: '2026-10-02',
  local_time: '10:00:00',
}

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

beforeEach(() => {
  // Only the clock: the promises and the polling of findBy* keep real timers.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-30T08:00:00Z') })
  api.manageSlots.mockReset()
  api.manageSlots.mockResolvedValue({ slots: [THU_0930, FRI_1000] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderView(onMove: (startsAt: string) => Promise<string | null>) {
  return render(
    <RescheduleView
      token={TOKEN}
      view={testManageView()}
      pending={false}
      onMove={onMove}
      onKeep={vi.fn()}
    />,
  )
}

const cta = () => screen.getByRole('button', { name: /^(Μετακίνηση|Διάλεξε νέα ώρα)/ })

describe('RescheduleView', () => {
  it('another day drops the chosen time; the button names the day it moves to', async () => {
    const onMove = vi.fn().mockResolvedValue(null)
    renderView(onMove)

    ;(await screen.findByRole('button', { name: '09:30' })).click()
    await waitFor(() => expect(cta()).toHaveAccessibleName(/^Μετακίνηση: .*1.*, 09:30$/))
    expect(cta()).toBeEnabled()

    screen.getByRole('button', { name: 'Παρασκευή 2 Οκτωβρίου' }).click()
    await waitFor(() => expect(cta()).toHaveAccessibleName('Διάλεξε νέα ώρα'))
    expect(cta()).toBeDisabled()
    expect(screen.getByRole('button', { name: '10:00' })).toHaveAttribute('aria-pressed', 'false')

    screen.getByRole('button', { name: '10:00' }).click()
    await waitFor(() => expect(cta()).toHaveAccessibleName(/^Μετακίνηση: .*2.*, 10:00$/))
    cta().click()
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(FRI_1000.starts_at))
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('after AN001 the times are asked for again and the taken one is no longer chosen', async () => {
    const onMove = vi.fn().mockResolvedValue('AN001')
    renderView(onMove)
    ;(await screen.findByRole('button', { name: '09:30' })).click()
    await waitFor(() => expect(cta()).toBeEnabled())
    expect(api.manageSlots).toHaveBeenCalledTimes(1)

    api.manageSlots.mockResolvedValue({ slots: [FRI_1000] })
    cta().click()
    await waitFor(() => expect(api.manageSlots).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: '09:30' })).toBeNull())
    expect(cta()).toBeDisabled()
  })

  it('a failed load offers a retry', async () => {
    api.manageSlots.mockRejectedValueOnce(new Error('offline'))
    renderView(vi.fn())
    ;(await screen.findByRole('button', { name: 'Δοκίμασε ξανά' })).click()
    expect(await screen.findByRole('button', { name: '09:30' })).toBeInTheDocument()
  })
})
