import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { RpcFailure } from '@/shared/lib/rpcError'
import type * as MfaApi from '../mfaApi'
import { readPendingEnrollment, savePendingEnrollment } from '../pendingEnrollment'
import type { StepUpDeps } from '../step-up'
import { StepUpContext } from '../stepUpContext'
import { EnrollWizard } from './EnrollWizard'

// The wizard with its real hook, form and storage; replaced: GoTrue and the RPC (mfaApi).
const api = vi.hoisted(() => ({
  listUnverifiedFactorIds: vi.fn<() => Promise<string[]>>(),
  unenrollUnverified: vi.fn<(id: string) => Promise<void>>(),
  authorizeFactorAdd: vi.fn(),
  enrollTotp: vi.fn(),
  verifyTotp: vi.fn(),
  stepUpVerify: vi.fn(),
}))
vi.mock('../mfaApi', async (importOriginal) => ({
  ...(await importOriginal<typeof MfaApi>()),
  ...api,
}))

// Synthetic ids (seed user …a013) and a made-up key.
const USER = '00000000-0000-4000-8000-00000000a013'
const OLD = '6f9619ff-8b86-4011-b42d-00c04fc96400'
const NEW = '6f9619ff-8b86-4011-b42d-00c04fc96401'
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const QR = 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E'
const URI = 'otpauth://totp/Anaklo:owner-enroll?secret=JBSWY3DPEHPK3PXP&issuer=Anaklo'

const TEXT = {
  step1: 'Κατέβασε μια εφαρμογή κωδικών',
  done: 'Την έχω',
  step2: 'Σκάναρε τον κωδικό QR',
  step3: 'Γράψε τον κωδικό 6 ψηφίων',
  next: 'Επόμενο',
  submit: 'Επιβεβαίωση',
  code: 'Κωδικός 6 ψηφίων',
  restart: 'Ξεκίνα από την αρχή',
} as const

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduce, addEventListener: () => {}, removeEventListener: () => {} })),
  )
}

function open({
  mode = 'first' as const,
  stepUp,
  blockedHandler = true,
}: {
  mode?: 'first' | 'second' | 'add'
  stepUp?: StepUpDeps
  /** Whether the host passes `onBlocked` (MfaEnrollPage does). */
  blockedHandler?: boolean
} = {}) {
  const onDone = vi.fn()
  const onBlocked = vi.fn()
  const onAuthRecheck = vi.fn()
  const askForCode = vi.fn(() => Promise.resolve(true))
  const deps: StepUpDeps = stepUp ?? { askForCode, onAuthRecheck }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { networkMode: 'always', retry: 0 } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <StepUpContext value={deps}>
        <EnrollWizard
          mode={mode}
          userId={USER}
          verifiedCount={mode === 'first' ? 0 : 1}
          onDone={onDone}
          onBlocked={blockedHandler ? onBlocked : undefined}
        />
      </StepUpContext>
    </QueryClientProvider>,
  )
  return { onDone, onBlocked, askForCode, onAuthRecheck }
}

function stepContainer(): HTMLElement {
  const step = document.querySelector<HTMLElement>('[data-step]')
  if (!step) throw new Error('no step')
  return step
}

async function toScan() {
  fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
  await screen.findByRole('heading', { name: TEXT.step2 })
}

beforeAll(async () => {
  await initI18n(proCatalogues)
})

/** The order of the calls of a generation. */
let order: string[] = []

beforeEach(() => {
  window.sessionStorage.clear()
  reducedMotion(false)
  order = []
  api.listUnverifiedFactorIds.mockImplementation(() => {
    order.push('list')
    return Promise.resolve([OLD])
  })
  api.unenrollUnverified.mockImplementation((id) => {
    order.push(`unenroll:${id}`)
    return Promise.resolve()
  })
  api.authorizeFactorAdd.mockImplementation(() => {
    order.push('authorize')
    return Promise.resolve({})
  })
  api.enrollTotp.mockImplementation((name: string, issuer: string) => {
    order.push(`enroll:${name}:${issuer}`)
    return Promise.resolve({ factorId: NEW, qrDataUri: QR, secret: SECRET, uri: URI })
  })
  api.verifyTotp.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EnrollWizard (contract 1.7 §6.4)', () => {
  it('unverified factors go first, then the permission, then the enrolment', async () => {
    const { askForCode } = open()
    expect(screen.getByText('Βήμα 1 από 3')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: TEXT.step1 })).toBeInTheDocument()
    expect(screen.getByLabelText('Όνομα συσκευής')).toHaveValue('Συσκευή 1')
    await toScan()
    expect(order).toEqual(['list', `unenroll:${OLD}`, 'authorize', 'enroll:Συσκευή 1:Anaklo'])
    // The first enrolment passed at aal1: no code sheet.
    expect(askForCode).not.toHaveBeenCalled()
    expect(screen.getByText('Βήμα 2 από 3')).toBeInTheDocument()
  })

  it('shows the QR only as an <img> with the SVG data URI, the app link and the key', async () => {
    open()
    await toScan()
    const qr = screen.getByRole('img', { name: 'Κωδικός QR για την εφαρμογή κωδικών' })
    expect(qr.tagName).toBe('IMG')
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(document.querySelector('svg')).toBeNull()
    expect(screen.getByRole('link', { name: 'Άνοιγμα στην εφαρμογή κωδικών' })).toHaveAttribute(
      'href',
      URI,
    )
    expect(screen.getByTestId('enroll-key')).toHaveTextContent(SECRET)
    // The secret, the QR and the URI never reach the storage.
    const raw = JSON.stringify(window.sessionStorage)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('otpauth')
    expect(readPendingEnrollment(window.sessionStorage, USER, new Date())).toMatchObject({
      factorId: NEW,
      stage: 'scan',
    })
  })

  it('a value that is not an SVG data URI shows no image, only the key', async () => {
    api.enrollTotp.mockResolvedValue({ factorId: NEW, qrDataUri: null, secret: SECRET, uri: URI })
    open()
    await toScan()
    expect(screen.queryByRole('img')).toBeNull()
    expect(
      screen.getByText('Ο κωδικός QR δεν εμφανίζεται εδώ. Χρησιμοποίησε το κλειδί.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('enroll-key')).toHaveTextContent(SECRET)
  })

  it('«Επόμενο» marks the code stage; success only after GoTrue verified the code', async () => {
    let answer: (value: { ok: true }) => void = () => {}
    api.verifyTotp.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const { onDone } = open()
    await toScan()
    fireEvent.click(screen.getByRole('button', { name: TEXT.next }))
    await screen.findByRole('heading', { name: TEXT.step3 })
    expect(readPendingEnrollment(window.sessionStorage, USER, new Date())?.stage).toBe('code')
    fireEvent.change(screen.getByLabelText(TEXT.code), { target: { value: '123 456' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.submit }))
    await waitFor(() => expect(api.verifyTotp).toHaveBeenCalledWith(NEW, '123456'))
    expect(onDone).not.toHaveBeenCalled()
    answer({ ok: true })
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
    expect(readPendingEnrollment(window.sessionStorage, USER, new Date())).toBeNull()
  })

  it('a wrong code says so and does not finish', async () => {
    api.verifyTotp.mockResolvedValue({ ok: false, reason: 'invalid_code' })
    const { onDone } = open()
    await toScan()
    fireEvent.click(screen.getByRole('button', { name: TEXT.next }))
    await screen.findByRole('heading', { name: TEXT.step3 })
    fireEvent.change(screen.getByLabelText(TEXT.code), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.submit }))
    expect(
      await screen.findByText(
        'Ο κωδικός δεν είναι σωστός. Γράψε αυτόν που δείχνει τώρα η εφαρμογή.',
      ),
    ).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('a name the user already has: back to step 1 with the reason', async () => {
    const { EnrollFailure } = await vi.importActual<typeof MfaApi>('../mfaApi')
    api.enrollTotp.mockRejectedValue(new EnrollFailure('name_taken'))
    open()
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    expect(await screen.findByText('Υπάρχει ήδη συσκευή με αυτό το όνομα.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: TEXT.step1 })).toBeInTheDocument()
  })

  it('a resume at the code stage opens step 3 for that device, without a new enrolment', async () => {
    savePendingEnrollment(window.sessionStorage, {
      userId: USER,
      factorId: NEW,
      friendlyName: 'Συσκευή 1',
      mode: 'first',
      stage: 'code',
      createdAt: Date.now(),
    })
    api.listUnverifiedFactorIds.mockResolvedValue([NEW])
    open()
    await screen.findByRole('heading', { name: TEXT.step3 })
    expect(api.enrollTotp).not.toHaveBeenCalled()
    expect(api.unenrollUnverified).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: TEXT.restart })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(TEXT.code), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.submit }))
    await waitFor(() => expect(api.verifyTotp).toHaveBeenCalledWith(NEW, '654321'))
  })

  it('a resume at the QR stage removes that device and generates a new one', async () => {
    savePendingEnrollment(window.sessionStorage, {
      userId: USER,
      factorId: OLD,
      friendlyName: 'Το iPhone μου',
      mode: 'first',
      stage: 'scan',
      createdAt: Date.now(),
    })
    open()
    await screen.findByRole('heading', { name: TEXT.step2 })
    expect(api.unenrollUnverified).toHaveBeenCalledWith(OLD)
    expect(api.enrollTotp).toHaveBeenCalledWith('Το iPhone μου', 'Anaklo')
  })

  it('«Ξεκίνα από την αρχή» removes the unverified device and goes back to step 1', async () => {
    savePendingEnrollment(window.sessionStorage, {
      userId: USER,
      factorId: NEW,
      friendlyName: 'Συσκευή 1',
      mode: 'first',
      stage: 'code',
      createdAt: Date.now(),
    })
    api.listUnverifiedFactorIds.mockResolvedValue([NEW])
    open()
    fireEvent.click(await screen.findByRole('button', { name: TEXT.restart }))
    await screen.findByRole('heading', { name: TEXT.step1 })
    await waitFor(() => expect(api.unenrollUnverified).toHaveBeenCalledWith(NEW))
    expect(readPendingEnrollment(window.sessionStorage, USER, new Date())).toBeNull()
  })

  it('a stale code for an added device opens the code sheet, then the permission once more', async () => {
    api.authorizeFactorAdd
      .mockRejectedValueOnce(new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' }))
      .mockResolvedValue({})
    const askForCode = vi.fn(() => Promise.resolve(true))
    open({ mode: 'add', stepUp: { askForCode, onAuthRecheck: vi.fn() } })
    expect(screen.getByLabelText('Όνομα συσκευής')).toHaveValue('Συσκευή 2')
    await toScan()
    expect(askForCode).toHaveBeenCalledExactlyOnceWith('fresh_totp_required')
    expect(api.authorizeFactorAdd).toHaveBeenCalledTimes(2)
  })

  it('a closed code sheet: no enrolment, the reason on step 1', async () => {
    api.authorizeFactorAdd.mockRejectedValue(
      new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' }),
    )
    open({
      mode: 'add',
      stepUp: { askForCode: () => Promise.resolve(false), onAuthRecheck: vi.fn() },
    })
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    expect(await screen.findByText('Η ενέργεια δεν έγινε.')).toBeInTheDocument()
    expect(api.enrollTotp).not.toHaveBeenCalled()
  })
})

describe('EnrollWizard when adding a device is blocked (AN034, contract 1.9b §4.4)', () => {
  /** What PostgREST answers for `private.raise_domain_error('AN034')`. */
  const BLOCKED = { code: 'P0001', message: 'AN034', hint: 'enrolment_blocked' }
  const AN034_TEXT =
    'Για την ασφάλειά σου, δεν μπορεί να προστεθεί συσκευή κωδικών σε αυτόν τον λογαριασμό. Επικοινώνησε με τη Nous.'

  it('first enrolment: onBlocked once, nothing else (no message, no enrolment, no sheet)', async () => {
    api.authorizeFactorAdd.mockImplementation(() => {
      order.push('authorize')
      return Promise.reject(new RpcFailure({ kind: 'domain', code: 'AN034' }))
    })
    const { onBlocked, onDone, askForCode, onAuthRecheck } = open()
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    await waitFor(() => expect(onBlocked).toHaveBeenCalledOnce())
    expect(order).toEqual(['list', `unenroll:${OLD}`, 'authorize'])
    expect(api.enrollTotp).not.toHaveBeenCalled()
    expect(askForCode).not.toHaveBeenCalled()
    expect(onAuthRecheck).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(AN034_TEXT)).toBeNull()
    expect(api.authorizeFactorAdd).toHaveBeenCalledOnce()
  })

  it('also when the refusal is the raw PostgREST error (classified on the way)', async () => {
    api.authorizeFactorAdd.mockRejectedValue(BLOCKED)
    const { onBlocked, askForCode } = open()
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    await waitFor(() => expect(onBlocked).toHaveBeenCalledOnce())
    expect(api.enrollTotp).not.toHaveBeenCalled()
    expect(askForCode).not.toHaveBeenCalled()
  })

  it('a resume at the QR stage that is refused goes to onBlocked, without a new enrolment', async () => {
    savePendingEnrollment(window.sessionStorage, {
      userId: USER,
      factorId: OLD,
      friendlyName: 'Συσκευή 1',
      mode: 'first',
      stage: 'scan',
      createdAt: Date.now(),
    })
    api.authorizeFactorAdd.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN034' }))
    const { onBlocked } = open()
    await waitFor(() => expect(onBlocked).toHaveBeenCalledOnce())
    expect(api.enrollTotp).not.toHaveBeenCalled()
    expect(readPendingEnrollment(window.sessionStorage, USER, new Date())).toBeNull()
  })

  it.each(['add', 'second'] as const)(
    'mode %s: the generic text of AN034, no onBlocked, no enrolment',
    async (mode) => {
      api.authorizeFactorAdd.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN034' }))
      const { onBlocked, askForCode } = open({ mode })
      fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
      expect(await screen.findByText(AN034_TEXT)).toBeInTheDocument()
      expect(onBlocked).not.toHaveBeenCalled()
      expect(askForCode).not.toHaveBeenCalled()
      expect(api.enrollTotp).not.toHaveBeenCalled()
      expect(screen.getByRole('heading', { name: TEXT.step1 })).toBeInTheDocument()
    },
  )

  it('first enrolment without a handler: the same text (never a silent failure)', async () => {
    api.authorizeFactorAdd.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN034' }))
    open({ blockedHandler: false })
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    expect(await screen.findByText(AN034_TEXT)).toBeInTheDocument()
    expect(api.enrollTotp).not.toHaveBeenCalled()
  })

  it('another domain error in the first enrolment is a message, not onBlocked', async () => {
    api.authorizeFactorAdd.mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN030' }))
    const { onBlocked } = open()
    fireEvent.click(screen.getByRole('button', { name: TEXT.done }))
    expect(await screen.findByText('Δεν είναι πια μέλος της επιχείρησης.')).toBeInTheDocument()
    expect(onBlocked).not.toHaveBeenCalled()
  })
})

describe('EnrollWizard motion (E14, MOTION.md §6)', () => {
  it('the first step has no entrance; a step change enters with E14', async () => {
    open()
    expect(stepContainer()).not.toHaveClass('step-enter')
    await toScan()
    expect(stepContainer()).toHaveClass('step-enter')
    fireEvent.click(screen.getByRole('button', { name: TEXT.next }))
    await screen.findByRole('heading', { name: TEXT.step3 })
    fireEvent.click(screen.getByRole('button', { name: 'Πίσω στον κωδικό QR' }))
    await screen.findByRole('heading', { name: TEXT.step2 })
    expect(stepContainer()).toHaveClass('step-enter-back')
  })

  it('with reduced motion nothing moves: no E14 class on any step', async () => {
    reducedMotion(true)
    open()
    await toScan()
    expect(stepContainer().className).not.toMatch(/step-enter/)
    fireEvent.click(screen.getByRole('button', { name: TEXT.next }))
    await screen.findByRole('heading', { name: TEXT.step3 })
    expect(stepContainer().className).not.toMatch(/step-enter/)
    expect(within(stepContainer()).getByRole('heading', { name: TEXT.step3 })).toBeVisible()
  })
})
