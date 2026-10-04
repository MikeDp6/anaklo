import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { MfaRouteData } from '../loaders'
import { MfaBlockedPage } from './MfaBlockedPage'

// Synthetic data (seed user …a017, «manager-reset@»); the support contact is a placeholder, not
// Nous's real one. The real «Αποσύνδεση» renders (its sign-out is never clicked here).
const DATA: MfaRouteData = {
  user: { userId: '00000000-0000-4000-8000-00000000a017', email: 'manager-reset@demo-barber.test' },
  memberships: [
    { businessId: '00000000-0000-4000-8000-000000000001', role: 'manager', staffId: null },
  ],
  highestRole: 'manager',
  aal: 'aal1',
  verifiedFactors: [],
  enrolmentBlocked: true,
  next: null,
}

const TEXT = {
  title: 'Επικοινώνησε με τη Nous',
  body: 'Μια συσκευή κωδικών αφαιρέθηκε από τον λογαριασμό σου χωρίς να περάσει από την εφαρμογή. Για την ασφάλειά σου, νέα συσκευή κωδικών μπορεί να προστεθεί μόνο αφού η Nous επιβεβαιώσει ότι είσαι εσύ.',
  contact:
    'Γράψε ή τηλεφώνησε στη Nous. Θα σε καλέσουμε στο τηλέφωνο του καταστήματος που έχουμε και θα το ξεκλειδώσουμε μαζί. Αν μπορείς, άλλαξε πρώτα τον κωδικό του email σου.',
  noBypass: 'Η εφαρμογή δεν έχει άλλο τρόπο εισόδου χωρίς τη συσκευή.',
  signOut: 'Αποσύνδεση',
} as const

function open() {
  const router = createMemoryRouter(
    [
      {
        path: '/mfa/blocked',
        loader: () => DATA,
        hydrateFallbackElement: <p>loading</p>,
        element: <MfaBlockedPage />,
      },
    ],
    { initialEntries: ['/mfa/blocked'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('MfaBlockedPage, «Επικοινώνησε με τη Nous» (contract 1.9b §4.3)', () => {
  it('says in plain words what happened and how Nous unlocks it', async () => {
    open()
    expect(await screen.findByRole('heading', { level: 1, name: TEXT.title })).toBeInTheDocument()
    expect(screen.getByText(TEXT.body)).toBeInTheDocument()
    expect(screen.getByText(TEXT.contact)).toBeInTheDocument()
    expect(screen.getByText(TEXT.noBypass)).toBeInTheDocument()
  })

  it('Nous’s contact from the environment, as mailto:/tel: links', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    open()
    await screen.findByRole('heading', { name: TEXT.title })
    expect(
      screen.getByRole('link', { name: 'Email στη Nous: support@example.com' }),
    ).toHaveAttribute('href', 'mailto:support@example.com')
    expect(screen.getByRole('link', { name: 'Κλήση στη Nous: +30 210 000 0000' })).toHaveAttribute(
      'href',
      'tel:+302100000000',
    )
  })

  it('a missing or malformed contact is hidden; the explanation stays', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', 'call us')
    open()
    await screen.findByRole('heading', { name: TEXT.title })
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'mailto:support@example.com',
    ])
    cleanup()
    vi.stubEnv('VITE_SUPPORT_EMAIL', '')
    vi.stubEnv('VITE_SUPPORT_PHONE', '')
    open()
    await screen.findByRole('heading', { name: TEXT.title })
    expect(screen.queryAllByRole('link')).toEqual([])
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText(TEXT.contact)).toBeInTheDocument()
  })

  it('no way around Nous: no code field, no wizard step, no button but «Αποσύνδεση»', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    open()
    await screen.findByRole('heading', { name: TEXT.title })
    expect(screen.queryAllByRole('textbox')).toEqual([])
    expect(document.querySelector('input, form, [data-step]')).toBeNull()
    expect(screen.queryByText(/Βήμα \d από 3/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Την έχω' })).toBeNull()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName(TEXT.signOut)
    const targets = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(targets.sort()).toEqual(['mailto:support@example.com', 'tel:+302100000000'])
  })

  it('minimal motion: no entrance class, E16 (`pressable`) on the links only', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    open()
    await screen.findByRole('heading', { name: TEXT.title })
    expect(document.querySelector('[class*="enter"]')).toBeNull()
    for (const link of screen.getAllByRole('link')) expect(link).toHaveClass('pressable')
  })
})
