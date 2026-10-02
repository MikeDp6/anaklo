import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { TimeOffTarget } from '../hooks/useTimeOffForm'
import type { ConflictsQuery, ScheduleConflict, TimeOffInput } from '../schema'
import { SETTINGS_IDS as IDS, testConflict, testFrame } from '../testFixtures'
import { TimeOffSheet } from './TimeOffSheet'

const settingsApi = vi.hoisted(() => ({
  saveTimeOff: vi.fn<(businessId: string, input: TimeOffInput) => Promise<void>>(),
  deleteTimeOff: vi.fn<(businessId: string, id: string) => Promise<void>>(),
  fetchScheduleConflicts:
    vi.fn<
      (
        businessId: string,
        query: ConflictsQuery,
        signal?: AbortSignal,
      ) => Promise<ScheduleConflict[]>
    >(),
}))
vi.mock('@/features/settings/api', () => settingsApi)

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-02T05:00:00Z') })
  settingsApi.fetchScheduleConflicts.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NEW_ID = '00000000-0000-4000-8000-00000000f001'

function open(target: TimeOffTarget) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/settings/time-off',
        element: (
          <TimeOffSheet frame={testFrame()} today="2026-10-02" target={target} onClose={vi.fn()} />
        ),
      },
    ],
    { initialEntries: ['/settings/time-off'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return screen.getByRole('dialog')
}

describe('TimeOffSheet (contract 1.6 §4.7)', () => {
  it('a new all-day time off: the sheet’s id, whole local days, neutral reasons only', async () => {
    settingsApi.saveTimeOff.mockResolvedValue()
    const dialog = open({ kind: 'new', id: NEW_ID })
    expect(
      within(dialog)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Διακοπές', 'Απουσία', 'Προσωπικός λόγος', 'Άλλο'])
    fireEvent.change(within(dialog).getByLabelText('Επαγγελματίας'), {
      target: { value: IDS.alex },
    })
    fireEvent.change(within(dialog).getByLabelText('Από'), { target: { value: '2026-10-24' } })
    fireEvent.change(within(dialog).getByLabelText('Έως'), { target: { value: '2026-10-25' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))

    expect(await screen.findByText('Η άδεια αποθηκεύτηκε.')).toBeVisible()
    expect(settingsApi.saveTimeOff).toHaveBeenCalledWith(IDS.business, {
      id: NEW_ID,
      staffId: IDS.alex,
      reason: 'vacation',
      startsAt: '2026-10-23T21:00:00.000Z',
      endsAt: '2026-10-25T22:00:00.000Z',
      isNew: true,
    })
  })

  it('without a staff member nothing is sent', async () => {
    const dialog = open({ kind: 'new', id: NEW_ID })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(await within(dialog).findByText('Διάλεξε επαγγελματία.')).toBeVisible()
    expect(settingsApi.saveTimeOff).not.toHaveBeenCalled()
  })

  it('an overlap with their other time off says so in this screen’s words', async () => {
    settingsApi.saveTimeOff.mockRejectedValue(new RpcFailure({ kind: 'overlap' }))
    const dialog = open({
      kind: 'edit',
      timeOff: {
        id: NEW_ID,
        staffId: IDS.alex,
        reason: 'personal',
        startsAt: '2026-10-05T07:00:00+00:00',
        endsAt: '2026-10-05T10:30:00+00:00',
      },
    })
    expect(within(dialog).getByLabelText('Ώρα έναρξης')).toHaveValue('10:00')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await within(dialog).findByText('Ο επαγγελματίας έχει ήδη άδεια σε αυτό το διάστημα.'),
    ).toBeVisible()
    expect(settingsApi.saveTimeOff.mock.calls[0]?.[1]).toMatchObject({ isNew: false, id: NEW_ID })
  })

  it('an existing time off keeps its staff member: shown read-only; the save and the notice use it', async () => {
    settingsApi.saveTimeOff.mockResolvedValue()
    settingsApi.fetchScheduleConflicts.mockResolvedValue([testConflict({ staffId: IDS.alex })])
    const dialog = open({
      kind: 'edit',
      timeOff: {
        id: NEW_ID,
        staffId: IDS.alex,
        reason: 'vacation',
        startsAt: '2026-10-05T21:00:00+00:00',
        endsAt: '2026-10-09T21:00:00+00:00',
      },
    })
    // No picker: a time off is never moved to another staff member (0008 grants no UPDATE of
    // staff_id, so a changed pick would be dropped while the screen said «αποθηκεύτηκε»).
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    const staff = within(dialog).getByLabelText('Επαγγελματίας')
    expect(staff).toHaveValue('Άλεξ')
    expect(staff).toHaveAttribute('readonly')
    expect(
      within(dialog).getByText('Για άλλον επαγγελματία, διάγραψε αυτή την άδεια και πρόσθεσε νέα.'),
    ).toBeVisible()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('Η άδεια αποθηκεύτηκε.')).toBeVisible()
    expect(settingsApi.saveTimeOff.mock.calls[0]?.[1]).toMatchObject({
      id: NEW_ID,
      staffId: IDS.alex,
      isNew: false,
    })
    // The count and the link are about the row's staff member.
    expect(await screen.findByRole('link', { name: 'Δες τα ραντεβού' })).toHaveAttribute(
      'href',
      `/settings/conflicts?staff=${IDS.alex}&from=2026-10-06&to=2026-10-09`,
    )
    expect(settingsApi.fetchScheduleConflicts.mock.calls[0]?.[1]).toMatchObject({
      staffId: IDS.alex,
    })
  })

  it('a time off deleted elsewhere meanwhile: no «αποθηκεύτηκε», it says so', async () => {
    settingsApi.saveTimeOff.mockRejectedValue(new RpcFailure({ kind: 'gone' }))
    const dialog = open({
      kind: 'edit',
      timeOff: {
        id: NEW_ID,
        staffId: IDS.alex,
        reason: 'vacation',
        startsAt: '2026-10-05T21:00:00+00:00',
        endsAt: '2026-10-09T21:00:00+00:00',
      },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(
      await within(dialog).findByText('Δεν υπάρχει πια: ίσως διαγράφηκε από άλλη συσκευή.'),
    ).toBeVisible()
    expect(screen.queryByText('Η άδεια αποθηκεύτηκε.')).toBeNull()
  })

  it('a new time off longer than 366 days is refused before sending (the conflicts list answers 366 days)', async () => {
    const dialog = open({ kind: 'new', id: NEW_ID })
    fireEvent.change(within(dialog).getByLabelText('Επαγγελματίας'), {
      target: { value: IDS.alex },
    })
    fireEvent.change(within(dialog).getByLabelText('Από'), { target: { value: '2026-10-05' } })
    fireEvent.change(within(dialog).getByLabelText('Έως'), { target: { value: '2027-12-31' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Αποθήκευση' }))
    expect(await within(dialog).findByText('Μια άδεια διαρκεί έως 366 μέρες.')).toBeVisible()
    expect(settingsApi.saveTimeOff).not.toHaveBeenCalled()
  })

  it('an existing row is deleted after one confirmation, and only then', async () => {
    settingsApi.deleteTimeOff.mockResolvedValue()
    const dialog = open({
      kind: 'edit',
      timeOff: {
        id: NEW_ID,
        staffId: IDS.alex,
        reason: 'vacation',
        startsAt: '2026-10-23T21:00:00+00:00',
        endsAt: '2026-10-25T22:00:00+00:00',
      },
    })
    expect(within(dialog).getByRole('switch', { name: 'Όλη μέρα' })).toBeChecked()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Διαγραφή' }))
    expect(within(dialog).getByText('Να διαγραφεί;')).toBeVisible()
    expect(settingsApi.deleteTimeOff).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Διαγραφή' }))
    await waitFor(() =>
      expect(settingsApi.deleteTimeOff).toHaveBeenCalledWith(IDS.business, NEW_ID),
    )
    expect(await screen.findByText('Η άδεια διαγράφηκε.')).toBeVisible()
  })
})
