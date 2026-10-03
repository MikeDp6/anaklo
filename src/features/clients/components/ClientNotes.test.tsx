import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type { LiveClientCard, NoteInput } from '../schema'
import { CLIENT_IDS, liveCard } from '../testFixtures'
import { ClientNotes } from './ClientNotes'

const api = vi.hoisted(() => ({
  addClientNote: vi.fn<(businessId: string, input: NoteInput) => Promise<void>>(),
  deleteClientNote: vi.fn<(businessId: string, noteId: string) => Promise<number>>(),
}))
vi.mock('../api', () => api)

// Test data only.
const B = CLIENT_IDS.business
const NOTE = 'Σημείωση'

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

function open(card: LiveClientCard = liveCard()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ClientNotes businessId={B} authorId={CLIENT_IDS.owner} card={card} />
    </QueryClientProvider>,
  )
}

function write(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: NOTE }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Αποθήκευση' }))
}

describe('ClientNotes (contract 1.8 §4.5)', () => {
  it('lists the notes newest first as plain text, with who wrote them', () => {
    open()
    const list = within(screen.getByRole('list', { name: 'Σημειώσεις πελάτη' }))
    const items = list.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Θέλει κοντά στο πλάι.')
    expect(items[0]).toHaveTextContent('Εσύ')
    expect(items[1]).toHaveTextContent('Άλεξ · Προσωπικό')
  })

  it('«Η σημείωση αποθηκεύτηκε.» and an empty box only after the answer', async () => {
    let answer: () => void = () => {}
    api.addClientNote.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve()
        }),
    )
    open()
    write('  Κοντά στο πλάι, όχι λακ.  ')
    await waitFor(() => expect(api.addClientNote).toHaveBeenCalledOnce())
    const [business, input] = api.addClientNote.mock.calls[0] ?? []
    expect(business).toBe(B)
    expect(input).toMatchObject({
      clientId: CLIENT_IDS.client,
      authorId: CLIENT_IDS.owner,
      body: 'Κοντά στο πλάι, όχι λακ.',
    })
    expect(input?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(screen.queryByText('Η σημείωση αποθηκεύτηκε.')).toBeNull()
    expect(screen.getByRole('textbox', { name: NOTE })).toHaveValue('  Κοντά στο πλάι, όχι λακ.  ')

    answer()
    expect(await screen.findByText('Η σημείωση αποθηκεύτηκε.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: NOTE })).toHaveValue('')
  })

  it('an unknown outcome locks the form; «Δοκίμασε ξανά» resends the SAME note id', async () => {
    api.addClientNote
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce(undefined)
    open()
    write('Προτιμά πρωινές ώρες.')
    const retry = await screen.findByRole('button', { name: 'Δοκίμασε ξανά' })
    expect(screen.getByRole('textbox', { name: NOTE })).toBeDisabled()
    fireEvent.click(retry)
    expect(await screen.findByText('Η σημείωση αποθηκεύτηκε.')).toBeVisible()
    expect(api.addClientNote).toHaveBeenCalledTimes(2)
    const [first, second] = api.addClientNote.mock.calls.map(([, input]) => input)
    expect(second).toEqual(first)
  })

  it('a new note after a saved one gets a new id', async () => {
    api.addClientNote.mockResolvedValue(undefined)
    open()
    write('Πρώτη')
    await screen.findByText('Η σημείωση αποθηκεύτηκε.')
    write('Δεύτερη')
    await waitFor(() => expect(api.addClientNote).toHaveBeenCalledTimes(2))
    const [first, second] = api.addClientNote.mock.calls.map(([, input]) => input.id)
    expect(second).not.toBe(first)
  })

  it('an empty note is not sent', async () => {
    open()
    write('   ')
    expect(await screen.findByText('Γράψε τη σημείωση.')).toBeVisible()
    expect(api.addClientNote).not.toHaveBeenCalled()
  })

  it('«Διαγραφή» only where the server allows it, with one confirmation', async () => {
    api.deleteClientNote.mockResolvedValue(1)
    const card = liveCard()
    open({
      ...card,
      notes: card.notes.map((note) =>
        note.id === CLIENT_IDS.otherNote ? { ...note, canDelete: false } : note,
      ),
    })
    const items = within(screen.getByRole('list', { name: 'Σημειώσεις πελάτη' })).getAllByRole(
      'listitem',
    )
    expect(within(items[1] as HTMLElement).queryByRole('button')).toBeNull()
    const own = within(items[0] as HTMLElement)
    fireEvent.click(own.getByRole('button', { name: /^Διαγραφή σημείωσης της / }))
    expect(own.getByText('Να διαγραφεί η σημείωση;')).toBeVisible()
    expect(api.deleteClientNote).not.toHaveBeenCalled()
    fireEvent.click(own.getByRole('button', { name: 'Διαγραφή' }))
    await waitFor(() => expect(api.deleteClientNote).toHaveBeenCalledWith(B, CLIENT_IDS.note))
  })

  it('AN033 (the client was merged or erased meanwhile) shows its reason', async () => {
    api.addClientNote.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN033' }))
    open()
    write('Κάτι')
    expect(
      await screen.findByText(
        'Ο πελάτης άλλαξε στο μεταξύ (συγχωνεύτηκε ή ανωνυμοποιήθηκε). Άνοιξε ξανά την καρτέλα.',
      ),
    ).toBeVisible()
  })
})
