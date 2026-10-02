import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { StaffMember } from '@/features/staff/schema'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { InviteBody, InviteResult, Member } from '../schema'
import { InviteSheet } from './InviteSheet'

const api = vi.hoisted(() => ({
  fetchMembers: vi.fn(),
  inviteMember: vi.fn<(body: InviteBody) => Promise<InviteResult>>(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
}))
vi.mock('../api', () => api)
const stepUp = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/features/auth/hooks/useStepUp', () => ({
  useStepUp:
    () =>
    <T,>(call: () => Promise<T>): Promise<T> => {
      stepUp.calls += 1
      return call()
    },
}))

// Test data only (synthetic ids, names and addresses).
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const NEW_USER = '00000000-0000-4000-8000-00000000a020'
const ROWS = {
  nikos: '00000000-0000-4000-8000-000000000101',
  alex: '00000000-0000-4000-8000-000000000102',
  maria: '00000000-0000-4000-8000-000000000103',
  petros: '00000000-0000-4000-8000-000000000104',
} as const
const STAFF: StaffMember[] = [
  { id: ROWS.nikos, displayName: 'Νίκος', color: null, sort: 0, active: true },
  { id: ROWS.alex, displayName: 'Άλεξ', color: null, sort: 1, active: true },
  { id: ROWS.maria, displayName: 'Μαρία', color: null, sort: 2, active: true },
  { id: ROWS.petros, displayName: 'Πέτρος', color: null, sort: 3, active: false },
]
function member(userId: string, staffId: string | null): Member {
  return {
    userId,
    email: `${userId.slice(-4)}@demo-barber.test`,
    role: 'staff',
    staffId,
    staffName: null,
    signedIn: true,
    isSelf: false,
  }
}
const MEMBERS = [
  member('00000000-0000-4000-8000-00000000a001', ROWS.nikos),
  member('00000000-0000-4000-8000-00000000a003', ROWS.alex),
]

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

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <InviteSheet
        businessId={BUSINESS}
        businessName="Demo Barber"
        staff={STAFF}
        members={MEMBERS}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return within(screen.getByRole('dialog', { name: 'Πρόσκληση μέλους' }))
}

function fill(sheet: ReturnType<typeof open>, email: string) {
  fireEvent.change(sheet.getByLabelText('Email'), { target: { value: email } })
}

describe('InviteSheet (contract 1.7 §6.8)', () => {
  it('roles: manager or staff (staff by default), never owner (D4)', () => {
    const sheet = open()
    expect(sheet.getByRole('radio', { name: 'Προσωπικό' })).toBeChecked()
    expect(sheet.getByRole('radio', { name: 'Διαχειριστής' })).not.toBeChecked()
    expect(sheet.queryByRole('radio', { name: 'Ιδιοκτήτης' })).toBeNull()
  })

  it('the calendar rows offered: «Κανένας» and the active rows no member holds', () => {
    const sheet = open()
    const select = sheet.getByLabelText('Επαγγελματίας στο ημερολόγιο')
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Κανένας', 'Μαρία'])
    expect(select).toHaveValue('')
  })

  it('a wrong email is refused before any call', async () => {
    const sheet = open()
    fill(sheet, 'not-an-email')
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))
    expect(await sheet.findByText('Γράψε ένα σωστό email.')).toBeVisible()
    expect(api.inviteMember).not.toHaveBeenCalled()
  })

  it('sends the cleaned body through the step-up; the text only after the answer', async () => {
    let answer: (value: InviteResult) => void = () => {}
    api.inviteMember.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const sheet = open()
    fill(sheet, '  New@Example.TEST ')
    fireEvent.click(sheet.getByRole('radio', { name: 'Διαχειριστής' }))
    fireEvent.change(sheet.getByLabelText('Επαγγελματίας στο ημερολόγιο'), {
      target: { value: ROWS.maria },
    })
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))

    await waitFor(() => expect(api.inviteMember).toHaveBeenCalledTimes(1))
    expect(api.inviteMember).toHaveBeenCalledWith({
      business_id: BUSINESS,
      email: 'new@example.test',
      role: 'manager',
      staff_id: ROWS.maria,
    })
    expect(stepUp.calls).toBe(1)
    expect(sheet.queryByText('new@example.test προστέθηκε.')).toBeNull()

    answer({
      user_id: NEW_USER,
      email: 'new@example.test',
      role: 'manager',
      staff_id: ROWS.maria,
      added: true,
      user_created: true,
    })
    expect(await sheet.findByText('new@example.test προστέθηκε.')).toBeVisible()
    expect(
      sheet.getByText(
        `Σε πρόσθεσα στο Demo Barber στο Anaklo. Άνοιξε το ${window.location.origin}/app/ στο κινητό σου, πρόσθεσέ το στην αρχική οθόνη και μπες με το email new@example.test: θα σου έρθει κωδικός.`,
      ),
    ).toBeVisible()
  })

  it('already a member with that role: «Ήταν ήδη μέλος.»', async () => {
    api.inviteMember.mockResolvedValue({
      user_id: NEW_USER,
      email: 'new@example.test',
      role: 'staff',
      staff_id: null,
      added: false,
      user_created: false,
    })
    const sheet = open()
    fill(sheet, 'new@example.test')
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))
    expect(await sheet.findByText('Ήταν ήδη μέλος.')).toBeVisible()
  })

  it('«Αντιγραφή κειμένου» copies the text; «Κοινοποίηση» only where the phone can share', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    onTestFinished(() => {
      Reflect.deleteProperty(window.navigator, 'clipboard')
    })
    api.inviteMember.mockResolvedValue({
      user_id: NEW_USER,
      email: 'new@example.test',
      role: 'staff',
      staff_id: null,
      added: true,
      user_created: true,
    })
    const sheet = open()
    fill(sheet, 'new@example.test')
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))
    fireEvent.click(await sheet.findByRole('button', { name: 'Αντιγραφή κειμένου' }))
    expect(await sheet.findByText('Αντιγράφηκε.')).toBeVisible()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('new@example.test'))
    expect(sheet.queryByRole('button', { name: 'Κοινοποίηση' })).toBeNull()
  })

  it('a calendar row another login took meanwhile (AN029): its text', async () => {
    api.inviteMember.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN029' }))
    const sheet = open()
    fill(sheet, 'new@example.test')
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))
    expect(await sheet.findByText('Αυτός ο επαγγελματίας έχει ήδη δική του σύνδεση.')).toBeVisible()
    expect(sheet.getByRole('button', { name: 'Πρόσκληση' })).toBeEnabled()
  })

  it('an account of another business (AN031): only Nous attaches it, and the sheet says so', async () => {
    // Review fix (contract 1.7 §10): no owner attaches a user of another business without consent.
    api.inviteMember.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN031' }))
    const sheet = open()
    fill(sheet, 'barber@other-shop.test')
    fireEvent.click(sheet.getByRole('button', { name: 'Πρόσκληση' }))
    expect(
      await sheet.findByText(
        'Αυτό το email δεν μπορεί να προστεθεί από εδώ. Επικοινώνησε με τη Nous.',
      ),
    ).toBeVisible()
    expect(sheet.queryByRole('button', { name: 'Αντιγραφή κειμένου' })).toBeNull()
  })
})
