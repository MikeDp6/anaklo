import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { useClientCard } from '../hooks/useClientCard'
import { toClientCard, type ClientCard, type ConsentInput, type SetConsentResult } from '../schema'
import { CLIENT_IDS, liveCardJson } from '../testFixtures'
import { ClientConsents } from './ClientConsents'

const api = vi.hoisted(() => ({
  fetchClientCard: vi.fn<(businessId: string, clientId: string) => Promise<ClientCard>>(),
  setClientConsent: vi.fn<(businessId: string, input: ConsentInput) => Promise<SetConsentResult>>(),
}))
vi.mock('../api', () => api)

// Test data only.
const B = CLIENT_IDS.business
const C = CLIENT_IDS.client
const NONE = { state: 'none', record_id: null }
const SWITCH = 'Προσφορές με SMS'

/** The card with marketing SMS in `state` (the record a staff_ui grant when granted). */
function cardWith(state: 'granted' | 'none'): ClientCard {
  const json = liveCardJson()
  const consents = json.consents as { current: Record<string, unknown> }
  return toClientCard({
    ...json,
    consents: {
      current: {
        ...consents.current,
        marketing_sms: state === 'granted' ? { state, record_id: CLIENT_IDS.grant } : NONE,
      },
      records:
        state === 'granted'
          ? [
              {
                id: CLIENT_IDS.grant,
                client_id: C,
                purpose: 'marketing_sms',
                legal_basis: 'consent',
                granted: true,
                source: 'staff_ui',
                given_by: 'guardian',
                policy_version: 'staff-consent-2026-10-03',
                created_at: '2026-10-03T08:00:00+00:00',
                withdrawn_at: null,
              },
            ]
          : [],
    },
  })
}

function result(state: 'granted' | 'none', patch: Partial<SetConsentResult> = {}) {
  return {
    clientId: C,
    purpose: 'marketing_sms' as const,
    state,
    changed: true,
    consentId: null,
    withdrawn: 0,
    ...patch,
  }
}

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
  vi.unstubAllGlobals()
})

/** The section fed by the real card query, so a write's invalidation refetches it. */
function Harness() {
  const card = useClientCard(B, C)
  return card.data?.state === 'live' ? <ClientConsents businessId={B} card={card.data} /> : null
}

function open() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: SWITCH })

describe('ClientConsents (contract 1.8 §4.6, plan 1.8)', () => {
  it('on → the sheet first; «Καταγραφή συναίνεσης» sends a grant with who gave it', async () => {
    api.fetchClientCard.mockResolvedValueOnce(cardWith('none'))
    let answer: (value: SetConsentResult) => void = () => {}
    api.setClientConsent.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    open()
    expect(await screen.findByRole('switch', { name: SWITCH })).not.toBeChecked()
    expect(toggle()).toHaveAccessibleDescription('Δεν έχει δοθεί συναίνεση.')

    fireEvent.click(toggle())
    const sheet = within(
      await screen.findByRole('dialog', { name: 'Συναίνεση για προσφορές με SMS' }),
    )
    expect(api.setClientConsent).not.toHaveBeenCalled()
    fireEvent.click(
      sheet.getByRole('checkbox', { name: 'Τη δίνει γονιός ή κηδεμόνας (πελάτης κάτω των 15)' }),
    )
    fireEvent.click(sheet.getByRole('button', { name: 'Καταγραφή συναίνεσης' }))

    await waitFor(() => expect(api.setClientConsent).toHaveBeenCalledOnce())
    expect(api.setClientConsent).toHaveBeenCalledWith(B, {
      clientId: C,
      purpose: 'marketing_sms',
      granted: true,
      givenBy: 'guardian',
    })
    // Never optimistic: the switch is still off, the sheet still open, until the answer.
    expect(toggle()).not.toBeChecked()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    api.fetchClientCard.mockResolvedValueOnce(cardWith('granted'))
    answer(result('granted', { consentId: CLIENT_IDS.grant }))
    expect(await screen.findByText('Η συναίνεση καταγράφηκε.')).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
    // The switch follows the refetched server state.
    await waitFor(() => expect(toggle()).toBeChecked())
    expect(toggle()).toHaveAccessibleDescription(/Συναίνεση στο κατάστημα, .+, από κηδεμόνα\./)
  })

  it('off → the withdrawal at once, without a sheet, and nothing but purpose and false', async () => {
    api.fetchClientCard.mockResolvedValueOnce(cardWith('granted'))
    api.setClientConsent.mockResolvedValue(result('none', { withdrawn: 1 }))
    open()
    expect(await screen.findByRole('switch', { name: SWITCH })).toBeChecked()

    api.fetchClientCard.mockResolvedValueOnce(cardWith('none'))
    fireEvent.click(toggle())
    await waitFor(() => expect(api.setClientConsent).toHaveBeenCalledOnce())
    expect(api.setClientConsent).toHaveBeenCalledWith(B, {
      clientId: C,
      purpose: 'marketing_sms',
      granted: false,
      givenBy: null,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Η συναίνεση ανακλήθηκε.')).toBeVisible()
    await waitFor(() => expect(toggle()).not.toBeChecked())
  })

  it('a closed sheet records nothing and leaves the switch as the server has it', async () => {
    api.fetchClientCard.mockResolvedValue(cardWith('none'))
    open()
    fireEvent.click(await screen.findByRole('switch', { name: SWITCH }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Κλείσιμο' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.setClientConsent).not.toHaveBeenCalled()
    expect(toggle()).not.toBeChecked()
  })

  it('the history lists every record with its source and withdrawal', async () => {
    const json = liveCardJson()
    const consents = json.consents as { current: object; records: object[] }
    api.fetchClientCard.mockResolvedValue(
      toClientCard({
        ...json,
        consents: {
          ...consents,
          records: [
            ...consents.records,
            {
              id: CLIENT_IDS.refusal,
              client_id: CLIENT_IDS.merged,
              purpose: 'photos_record',
              legal_basis: 'consent',
              granted: true,
              source: 'staff_ui',
              given_by: 'client',
              policy_version: 'staff-consent-2026-10-03',
              created_at: '2026-06-01T08:00:00+00:00',
              withdrawn_at: '2026-07-01T08:00:00+00:00',
            },
          ],
        },
      }),
    )
    open()
    expect(await screen.findByRole('switch', { name: SWITCH })).toHaveAccessibleDescription(
      /^Από τη φόρμα κράτησης, .+ \(με δυνατότητα άρνησης\)\.$/,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Προσφορές με SMS · Ναι')
    expect(items[0]).toHaveTextContent('Φόρμα κράτησης')
    expect(items[1]).toHaveTextContent('Φωτογραφίες στο αρχείο του καταστήματος · Ναι')
    expect(items[1]).toHaveTextContent(/ανακλήθηκε .+2026/)
  })
})
