import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { BookingPolicy, BookingPolicyInput } from '../schema'
import { SETTINGS_IDS as IDS } from '../testFixtures'
import { BookingPolicyForm } from './BookingPolicyPage'

const settingsApi = vi.hoisted(() => ({
  updateBookingPolicy:
    vi.fn<(businessId: string, input: BookingPolicyInput) => Promise<BookingPolicy>>(),
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
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const POLICY: BookingPolicy = {
  id: IDS.business,
  timeZone: 'Europe/Athens',
  bookingEnabled: true,
  slotStepMin: 15,
  minNoticeMin: 45, // not a preset: provisioning set it (D18)
  maxAdvanceDays: 60,
  cancelMinNoticeMin: 120,
  autoCompleteAfterMin: 720,
  correctionWindowDays: 3,
  allowAnyStaff: true,
  messagingEnabled: true,
  quietStart: '22:00',
  quietEnd: '09:00',
  reminderMode: '24h',
}

function open(policy: BookingPolicy = POLICY) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <BookingPolicyForm businessId={IDS.business} policy={policy} />
    </QueryClientProvider>,
  )
}

describe('BookingPolicyForm (contract 1.6 §4.8)', () => {
  it('shows the stored values; minutes read as words; a non-preset value is an extra option', () => {
    open()
    const notice = screen.getByLabelText<HTMLSelectElement>('Ελάχιστη προειδοποίηση')
    expect(notice.value).toBe('45')
    expect(within(notice).getByRole('option', { selected: true })).toHaveTextContent('45 λεπτά')
    expect(within(notice).getByRole('option', { name: '1 ώρα' })).toBeInTheDocument()
    expect(screen.getByLabelText('Αυτόματη ολοκλήρωση μετά από')).toHaveValue('720')
    expect(screen.getByRole('switch', { name: /^Online κρατήσεις/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: '24 ώρες πριν' })).toBeChecked()
    expect(screen.getByLabelText('Από')).toHaveValue('22:00')
    expect(screen.getByText(/Οι υπενθυμίσεις που περιμένουν ακολουθούν/)).toBeVisible()
  })

  it('saves every field once and refills the form from the server’s answer', async () => {
    settingsApi.updateBookingPolicy.mockImplementation((_b, input) =>
      Promise.resolve({ ...POLICY, ...input }),
    )
    open()
    fireEvent.change(screen.getByLabelText('Βήμα ωρών'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('switch', { name: /^Υπενθυμίσεις με SMS/ }))
    expect(screen.queryByText('Αποθηκεύτηκε')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('Αποθηκεύτηκε')).toBeVisible()
    expect(settingsApi.updateBookingPolicy).toHaveBeenCalledWith(IDS.business, {
      bookingEnabled: true,
      slotStepMin: 30,
      minNoticeMin: 45,
      maxAdvanceDays: 60,
      cancelMinNoticeMin: 120,
      autoCompleteAfterMin: 720,
      correctionWindowDays: 3,
      allowAnyStaff: true,
      messagingEnabled: false,
      reminderMode: '24h',
      quietStart: '22:00',
      quietEnd: '09:00',
    })
    expect(screen.getByLabelText('Βήμα ωρών')).toHaveValue('30')
  })

  it('a quiet window outside 1–12 hours is caught before any request', async () => {
    open()
    // 20:00 → 09:00 is 13 hours.
    fireEvent.change(screen.getByLabelText('Από'), { target: { value: '20:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    expect(await screen.findByText('Οι ώρες ησυχίας διαρκούν από 1 έως 12 ώρες.')).toBeVisible()
    expect(settingsApi.updateBookingPolicy).not.toHaveBeenCalled()
  })

  it('a value the database refuses shows «Κάποια τιμή δεν είναι έγκυρη»', async () => {
    settingsApi.updateBookingPolicy.mockRejectedValue(new RpcFailure({ kind: 'invalid' }))
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Κάποια τιμή δεν είναι έγκυρη. Έλεγξε τα πεδία.',
      ),
    )
  })
})
