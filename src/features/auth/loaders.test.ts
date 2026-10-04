import type { LoaderFunctionArgs } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole } from '@/shared/lib/domain'
import {
  afterCodePath,
  appPath,
  mfaLoader,
  requireMembership,
  safeNext,
  secondDeviceLoader,
  withNext,
} from './loaders'
import type { AuthState, VerifiedFactor } from './mfaApi'

const mocks = vi.hoisted(() => ({
  currentActiveUser: vi.fn(),
  signOutRevoked: vi.fn(),
  fetchMemberships: vi.fn(),
  getSessionUser: vi.fn(),
  fetchAuthState: vi.fn(),
  fetchEnrolmentBlocked: vi.fn(),
}))
vi.mock('./session', () => ({
  currentActiveUser: mocks.currentActiveUser,
  signOutRevoked: mocks.signOutRevoked,
}))
vi.mock('./api', () => ({
  fetchMemberships: mocks.fetchMemberships,
  getSessionUser: mocks.getSessionUser,
}))
vi.mock('./mfaApi', () => ({
  fetchAuthState: mocks.fetchAuthState,
  fetchEnrolmentBlocked: mocks.fetchEnrolmentBlocked,
}))

// Synthetic ids (demo seed).
const USER = { userId: '00000000-0000-4000-8000-00000000a001', email: 'owner@demo-barber.test' }
const B1 = '00000000-0000-4000-8000-000000000001'
const B2 = '00000000-0000-4000-8000-000000000002'
const DEVICE: VerifiedFactor = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc96401',
  friendlyName: 'iPhone',
  createdAt: '2026-10-01T09:00:00Z',
}
const DEVICE_2: VerifiedFactor = { ...DEVICE, id: '6f9619ff-8b86-4011-b42d-00c04fc96402' }

function args(path: string): LoaderFunctionArgs {
  return {
    request: new Request(`http://localhost/app${path}`),
    params: {},
    context: undefined,
  } as unknown as LoaderFunctionArgs
}

function given(roles: MemberRole[], auth: AuthState, blocked = false) {
  mocks.currentActiveUser.mockResolvedValue(USER)
  mocks.fetchEnrolmentBlocked.mockResolvedValue(blocked)
  mocks.fetchMemberships.mockResolvedValue(
    roles.map((role, index) => ({ businessId: index === 0 ? B1 : B2, role, staffId: null })),
  )
  mocks.fetchAuthState.mockResolvedValue(auth)
}

const aal1 = (factors: VerifiedFactor[]): AuthState => ({
  kind: 'active',
  aal: 'aal1',
  verifiedFactors: factors,
})
const aal2 = (factors: VerifiedFactor[]): AuthState => ({
  kind: 'active',
  aal: 'aal2',
  verifiedFactors: factors,
})

function location(result: unknown): string | null {
  return result instanceof Response ? result.headers.get('Location') : null
}

beforeEach(() => {
  mocks.signOutRevoked.mockResolvedValue(undefined)
})

describe('requireMembership (member route, contract 1.7 §6.2)', () => {
  it('owner at aal1 with a device → the code screen, with where they were going', async () => {
    given(['owner'], aal1([DEVICE]))
    expect(location(await requireMembership(args('/settings/members?tab=1')))).toBe(
      '/mfa/challenge?next=%2Fsettings%2Fmembers%3Ftab%3D1',
    )
  })

  it('owner without a device → the blocking enrolment (any level)', async () => {
    given(['owner'], aal1([]))
    expect(location(await requireMembership(args('/')))).toBe('/mfa/enroll')
    given(['owner'], aal2([]))
    expect(location(await requireMembership(args('/day')))).toBe('/mfa/enroll')
  })

  it('the highest role decides: staff here, manager elsewhere → challenge', async () => {
    given(['staff', 'manager'], aal1([DEVICE]))
    expect(location(await requireMembership(args('/')))).toBe('/mfa/challenge')
  })

  it('staff → the member context, without a code step', async () => {
    given(['staff'], aal1([]))
    const result = await requireMembership(args('/'))
    expect(result).not.toBeInstanceOf(Response)
    expect(result).toMatchObject({
      user: USER,
      membership: { businessId: B1, role: 'staff' },
      highestRole: 'staff',
      aal: 'aal1',
      verifiedFactors: [],
    })
  })

  it('owner at aal2 with a device → the member context', async () => {
    given(['owner'], aal2([DEVICE]))
    expect(await requireMembership(args('/'))).toMatchObject({
      highestRole: 'owner',
      aal: 'aal2',
      verifiedFactors: [DEVICE],
    })
  })

  it('a revoked session → the device is cleaned up, then login', async () => {
    given(['owner'], { kind: 'revoked' })
    expect(location(await requireMembership(args('/')))).toBe('/login')
    expect(mocks.signOutRevoked).toHaveBeenCalledOnce()
  })

  it('no session → login; no membership → «no access»', async () => {
    mocks.currentActiveUser.mockResolvedValue(null)
    expect(location(await requireMembership(args('/')))).toBe('/login')
    given([], aal1([]))
    expect(location(await requireMembership(args('/')))).toBe('/no-access')
  })

  it('offline: the guard fails (the error page offers «Δοκίμασε ξανά»)', async () => {
    given(['owner'], aal2([DEVICE]))
    mocks.fetchAuthState.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(requireMembership(args('/'))).rejects.toThrow('Failed to fetch')
  })
})

describe('mfaLoader / secondDeviceLoader', () => {
  it('the code screen while that is the decision, with a safe next', async () => {
    given(['owner'], aal1([DEVICE]))
    expect(await mfaLoader('challenge')(args('/mfa/challenge?next=%2Fday'))).toMatchObject({
      next: '/day',
      verifiedFactors: [DEVICE],
    })
  })

  it('once done (aal2) the code screen goes on to next; a foreign next goes home', async () => {
    given(['owner'], aal2([DEVICE]))
    expect(location(await mfaLoader('challenge')(args('/mfa/challenge?next=%2Fday')))).toBe('/day')
    expect(
      location(await mfaLoader('challenge')(args('/mfa/challenge?next=%2F%2Fevil.test'))),
    ).toBe('/')
  })

  it('another decision → its own screen', async () => {
    given(['owner'], aal1([]))
    expect(location(await mfaLoader('challenge')(args('/mfa/challenge')))).toBe('/mfa/enroll')
    given(['owner'], aal1([DEVICE]))
    expect(location(await mfaLoader('enroll')(args('/mfa/enroll')))).toBe('/mfa/challenge')
    given(['staff'], aal1([]))
    expect(location(await mfaLoader('enroll')(args('/mfa/enroll')))).toBe('/')
  })

  it('second device: owner/manager with exactly one device only', async () => {
    given(['manager'], aal2([DEVICE]))
    expect(await secondDeviceLoader(args('/mfa/second-device?next=%2Fsettings'))).toMatchObject({
      next: '/settings',
      verifiedFactors: [DEVICE],
    })
    given(['manager'], aal2([DEVICE, DEVICE_2]))
    expect(location(await secondDeviceLoader(args('/mfa/second-device?next=%2Fday')))).toBe('/day')
    given(['staff'], aal1([]))
    expect(location(await secondDeviceLoader(args('/mfa/second-device')))).toBe('/')
    given(['owner'], aal1([DEVICE]))
    expect(location(await secondDeviceLoader(args('/mfa/second-device')))).toBe('/mfa/challenge')
  })
})

describe('blocked enrolment (contract 1.9b §4.2)', () => {
  it('owner/manager without a device and blocked → «Επικοινώνησε με τη Nous», never the wizard', async () => {
    for (const role of ['owner', 'manager'] as const) {
      given([role], aal1([]), true)
      expect(location(await requireMembership(args('/settings?x=1')))).toBe('/mfa/blocked')
      given([role], aal2([]), true)
      expect(location(await requireMembership(args('/')))).toBe('/mfa/blocked')
    }
  })

  it('owner/manager without a device, not blocked → the enrolment (the server was asked)', async () => {
    given(['manager'], aal1([]), false)
    expect(location(await requireMembership(args('/')))).toBe('/mfa/enroll')
    expect(mocks.fetchEnrolmentBlocked).toHaveBeenCalledOnce()
  })

  it('with a device, or staff, the server is never asked', async () => {
    given(['owner'], aal1([DEVICE]), true)
    expect(location(await requireMembership(args('/')))).toBe('/mfa/challenge')
    given(['owner'], aal2([DEVICE]), true)
    expect(await requireMembership(args('/'))).toMatchObject({ enrolmentBlocked: false })
    given(['staff'], aal1([]), true)
    expect(await requireMembership(args('/'))).toMatchObject({
      highestRole: 'staff',
      enrolmentBlocked: false,
    })
    given(['manager', 'staff'], aal2([DEVICE]), true)
    await secondDeviceLoader(args('/mfa/second-device'))
    expect(mocks.fetchEnrolmentBlocked).not.toHaveBeenCalled()
  })

  it('a revoked session or no membership: login / «no access» before any question', async () => {
    given(['owner'], { kind: 'revoked' }, true)
    expect(location(await requireMembership(args('/')))).toBe('/login')
    given([], aal1([]), true)
    expect(location(await requireMembership(args('/')))).toBe('/no-access')
    expect(mocks.fetchEnrolmentBlocked).not.toHaveBeenCalled()
  })

  it('mfa/enroll while blocked → mfa/blocked; mfa/challenge, mfa/lost-device too', async () => {
    given(['owner'], aal1([]), true)
    expect(location(await mfaLoader('enroll')(args('/mfa/enroll')))).toBe('/mfa/blocked')
    expect(location(await mfaLoader('challenge')(args('/mfa/challenge?next=%2Fday')))).toBe(
      '/mfa/blocked',
    )
    expect(location(await secondDeviceLoader(args('/mfa/second-device')))).toBe('/mfa/blocked')
  })

  it('mfa/blocked while blocked → the screen, without next', async () => {
    given(['manager'], aal1([]), true)
    expect(await mfaLoader('blocked')(args('/mfa/blocked'))).toMatchObject({
      highestRole: 'manager',
      verifiedFactors: [],
      enrolmentBlocked: true,
      next: null,
    })
  })

  it('mfa/blocked once Nous has reset: enrol → mfa/enroll; ok → next or «Σήμερα»', async () => {
    given(['owner'], aal1([]), false)
    expect(location(await mfaLoader('blocked')(args('/mfa/blocked')))).toBe('/mfa/enroll')
    given(['owner'], aal2([DEVICE]))
    expect(location(await mfaLoader('blocked')(args('/mfa/blocked?next=%2Fday')))).toBe('/day')
    expect(location(await mfaLoader('blocked')(args('/mfa/blocked')))).toBe('/')
    given(['staff'], aal1([]))
    expect(location(await mfaLoader('blocked')(args('/mfa/blocked')))).toBe('/')
    given(['owner'], aal1([DEVICE]))
    expect(location(await mfaLoader('blocked')(args('/mfa/blocked')))).toBe('/mfa/challenge')
  })

  it('the question failing fails the guard (the error page offers «Δοκίμασε ξανά»)', async () => {
    given(['owner'], aal1([]))
    mocks.fetchEnrolmentBlocked.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(requireMembership(args('/'))).rejects.toThrow('Failed to fetch')
    await expect(mfaLoader('enroll')(args('/mfa/enroll'))).rejects.toThrow('Failed to fetch')
  })
})

describe('paths', () => {
  it('safeNext accepts only in-app paths', () => {
    expect(safeNext('/settings?x=1')).toBe('/settings?x=1')
    expect(safeNext('/')).toBe('/')
    for (const bad of [
      null,
      '',
      '//x',
      '//evil.test/app',
      'https://evil.test',
      'settings',
      '/\\evil.test',
      '/mfa/challenge',
      '/mfa/enroll?next=%2F',
      '/login',
      '/no-access',
      '/day\nx',
    ]) {
      expect(safeNext(bad), String(bad)).toBeNull()
    }
  })

  it('appPath drops the basename', () => {
    expect(appPath(new Request('http://localhost/app/settings?x=1'))).toBe('/settings?x=1')
    expect(appPath(new Request('http://localhost/app'))).toBe('/')
    expect(appPath(new Request('http://localhost/day'))).toBe('/day')
  })

  it('withNext omits «Σήμερα»; afterCodePath shows the reminder with one device only', () => {
    expect(withNext('/mfa/challenge', '/')).toBe('/mfa/challenge')
    expect(withNext('/mfa/challenge', null)).toBe('/mfa/challenge')
    expect(afterCodePath(1, '/day')).toBe('/mfa/second-device?next=%2Fday')
    expect(afterCodePath(2, '/day')).toBe('/day')
    expect(afterCodePath(2, null)).toBe('/')
  })
})
