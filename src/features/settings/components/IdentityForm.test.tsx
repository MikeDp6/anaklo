import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { BusinessIdentity, IdentityChange, IdentityResult } from '../schema'
import { SETTINGS_IDS as IDS } from '../testFixtures'
import { IdentityForm } from './IdentityForm'

const settingsApi = vi.hoisted(() => ({
  changeBusinessIdentity:
    vi.fn<(businessId: string, change: IdentityChange) => Promise<IdentityResult>>(),
}))
vi.mock('@/features/settings/api', () => settingsApi)
const stepUp = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/features/auth/hooks/useStepUp', () => ({
  useStepUp:
    () =>
    <T,>(call: () => Promise<T>): Promise<T> => {
      stepUp.calls += 1
      return call()
    },
}))

// Test data only: the demo shop.
const IDENTITY: BusinessIdentity = {
  id: IDS.business,
  slug: 'demo-barber',
  timeZone: 'Europe/Athens',
  currency: 'EUR',
  aliases: [],
}
const TEXT = {
  slug: 'Τα links που έχουν ήδη σταλεί θα συνεχίσουν να δουλεύουν και θα οδηγούν στη νέα διεύθυνση. Η παλιά διεύθυνση δεν θα δοθεί ποτέ σε άλλη επιχείρηση.',
  timezone:
    'Τα ωράρια και τα κλεισίματα μένουν στις ίδιες τοπικές ώρες. Οι άδειες κρατούν την ίδια στιγμή, άρα η τοπική τους ώρα αλλάζει. Δεν γίνεται όσο υπάρχουν μελλοντικά ραντεβού.',
  currency:
    'Τα ποσά θα εμφανίζονται στο νέο νόμισμα χωρίς μετατροπή. Δεν γίνεται όσο υπάρχουν μελλοντικά ραντεβού.',
} as const

beforeAll(async () => {
  await initI18n(proCatalogues)
})

beforeEach(() => {
  stepUp.calls = 0
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function open(identity: BusinessIdentity = IDENTITY) {
  const router = createMemoryRouter(
    [{ path: '/', element: <IdentityForm businessId={IDS.business} identity={identity} /> }],
    { initialEntries: ['/'] },
  )
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const slug = () => screen.getByLabelText<HTMLInputElement>('Διεύθυνση σελίδας')
const zone = () => screen.getByLabelText<HTMLSelectElement>('Ζώνη ώρας')
const currency = () => screen.getByLabelText<HTMLSelectElement>('Νόμισμα')
const proceed = () => fireEvent.click(screen.getByRole('button', { name: 'Συνέχεια' }))

function stored(change: Partial<BusinessIdentity>, changed = true): IdentityResult {
  const next = { ...IDENTITY, ...change }
  return {
    stored: { slug: next.slug, timeZone: next.timeZone, currency: next.currency },
    changed,
    changedFields: [],
  }
}

describe('IdentityForm (contract 1.7 §6.9)', () => {
  it('shows the stored values and the full address; the slug is lower-cased as typed', () => {
    open()
    expect(slug()).toHaveValue('demo-barber')
    expect(zone()).toHaveValue('Europe/Athens')
    expect(currency()).toHaveValue('EUR')
    expect(
      screen.getByText(`${window.location.origin}/demo-barber`, { exact: false }),
    ).toBeVisible()
    fireEvent.change(slug(), { target: { value: 'New-Name' } })
    expect(slug()).toHaveValue('new-name')
    expect(screen.getByText(`${window.location.origin}/new-name`, { exact: false })).toBeVisible()
  })

  it('nothing changed: «Δεν άλλαξε κάτι.» and no confirmation', async () => {
    open()
    proceed()
    expect(await screen.findByText('Δεν άλλαξε κάτι.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Επιβεβαίωση αλλαγών' })).toBeNull()
  })

  it('the confirmation lists only the changed field with its consequence', async () => {
    open()
    fireEvent.change(slug(), { target: { value: 'new-name' } })
    proceed()
    const list = within(await screen.findByRole('list'))
    expect(list.getAllByRole('listitem')).toHaveLength(1)
    expect(list.getByText('Διεύθυνση σελίδας')).toBeVisible()
    expect(list.getByText('demo-barber → new-name')).toBeVisible()
    expect(list.getByText(TEXT.slug)).toBeVisible()
    expect(screen.queryByText(TEXT.timezone)).toBeNull()
    expect(screen.queryByText(TEXT.currency)).toBeNull()
    expect(settingsApi.changeBusinessIdentity).not.toHaveBeenCalled()
  })

  it('zone and currency: both, in order, each with its consequence; the slug is not listed', async () => {
    open()
    fireEvent.change(zone(), { target: { value: 'Europe/London' } })
    fireEvent.change(currency(), { target: { value: 'USD' } })
    proceed()
    const items = within(await screen.findByRole('list')).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Ζώνη ώρας')
    expect(items[0]).toHaveTextContent('Europe/Athens → Europe/London')
    expect(items[0]).toHaveTextContent(TEXT.timezone)
    expect(items[1]).toHaveTextContent('Νόμισμα')
    expect(items[1]).toHaveTextContent('EUR → USD')
    expect(items[1]).toHaveTextContent(TEXT.currency)
    expect(screen.queryByText(TEXT.slug)).toBeNull()
  })

  it('«Επιβεβαίωση αλλαγών» sends only the changes; «Αποθηκεύτηκε.» only after the answer', async () => {
    let answer: (value: IdentityResult) => void = () => {}
    settingsApi.changeBusinessIdentity.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    fireEvent.change(zone(), { target: { value: 'Europe/London' } })
    proceed()
    fireEvent.click(await screen.findByRole('button', { name: 'Επιβεβαίωση αλλαγών' }))
    await waitFor(() => expect(settingsApi.changeBusinessIdentity).toHaveBeenCalledTimes(1))
    expect(settingsApi.changeBusinessIdentity).toHaveBeenCalledWith(IDS.business, {
      timeZone: 'Europe/London',
    })
    expect(stepUp.calls).toBe(1)
    expect(screen.queryByText('Αποθηκεύτηκε.')).toBeNull()

    answer(stored({ timeZone: 'Europe/London' }))
    expect(await screen.findByText('Αποθηκεύτηκε.')).toBeVisible()
    expect(zone()).toHaveValue('Europe/London')
  })

  it.each([
    ['AN024', 'Αυτή η διεύθυνση δεν είναι διαθέσιμη. Δοκίμασε άλλη.'],
    [
      'AN025',
      'Υπάρχουν μελλοντικά ραντεβού. Η ζώνη ώρας και το νόμισμα αλλάζουν μόνο όταν δεν υπάρχει κανένα.',
    ],
  ] as const)('%s: its text, nothing shown as saved', async (code, text) => {
    settingsApi.changeBusinessIdentity.mockRejectedValue(new RpcFailure({ kind: 'domain', code }))
    open()
    fireEvent.change(slug(), { target: { value: 'taken-name' } })
    proceed()
    fireEvent.click(await screen.findByRole('button', { name: 'Επιβεβαίωση αλλαγών' }))
    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.queryByText('Αποθηκεύτηκε.')).toBeNull()
  })

  it('«Πίσω» returns to the fields with what was typed', async () => {
    open()
    fireEvent.change(slug(), { target: { value: 'new-name' } })
    proceed()
    fireEvent.click(await screen.findByRole('button', { name: 'Πίσω' }))
    expect(slug()).toHaveValue('new-name')
    expect(settingsApi.changeBusinessIdentity).not.toHaveBeenCalled()
  })
})
