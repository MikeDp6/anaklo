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
}))
vi.mock('./session', () => ({
  currentActiveUser: mocks.currentActiveUser,
  signOutRevoked: mocks.signOutRevoked,
}))
vi.mock('./api', () => ({
  fetchMemberships: mocks.fetchMemberships,
  getSessionUser: mocks.getSessionUser,
}))
vi.mock('./mfaApi', () => ({ fetchAuthState: mocks.fetchAuthState }))

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

function given(roles: MemberRole[], auth: AuthState) {
  mocks.currentActiveUser.mockResolvedValue(USER)
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
