import { describe, expect, it } from 'vitest'
import {
  notificationsView,
  pushStatus,
  testPushMessage,
  type PushDeviceState,
  type PushFacts,
} from './pushStatus'

const DEVICE = '8b1f6a52-3c1e-4c0d-9a4e-2f7d1c9b0e11'
const OTHER = '11111111-2222-4333-8444-555555555555'
const ON: PushFacts = {
  supported: true,
  permission: 'granted',
  optedIn: true,
  subscriptionId: DEVICE,
}

describe('pushStatus', () => {
  it.each([
    [
      { supported: false, permission: 'default', optedIn: false, subscriptionId: null },
      'unsupported',
    ],
    [{ supported: true, permission: null, optedIn: false, subscriptionId: null }, 'unsupported'],
    [{ supported: true, permission: 'denied', optedIn: false, subscriptionId: null }, 'denied'],
    [{ supported: true, permission: 'default', optedIn: false, subscriptionId: null }, 'off'],
    [{ supported: true, permission: 'granted', optedIn: false, subscriptionId: DEVICE }, 'off'],
    [{ supported: true, permission: 'granted', optedIn: true, subscriptionId: null }, 'off'],
    [ON, 'on'],
  ] as const)('%o with this device registered → %s', (facts, expected) => {
    expect(pushStatus(facts, [DEVICE])).toBe(expected)
  })

  it('is on only when this device is one of MY rows (ADR-0010 §7)', () => {
    expect(pushStatus(ON, [])).toBe('off')
    // Opted in, but the row belongs to someone else (or to nobody): not on for me.
    expect(pushStatus(ON, [OTHER])).toBe('off')
    expect(pushStatus(ON, [OTHER, DEVICE])).toBe('on')
  })

  it('compares ids without case (the server stores them in lower case)', () => {
    expect(pushStatus({ ...ON, subscriptionId: DEVICE.toUpperCase() }, [DEVICE])).toBe('on')
  })
})

describe('notificationsView', () => {
  const ready: PushDeviceState = { kind: 'ready', facts: ON }

  it('without a OneSignal app id: unavailable, no button', () => {
    expect(
      notificationsView({ device: { kind: 'unavailable' }, registeredIds: [], enable: 'idle' }),
    ).toEqual({ status: 'unavailable', action: null })
  })

  it('iOS outside the installed app: the install instruction, no button', () => {
    expect(
      notificationsView({ device: { kind: 'needsInstall' }, registeredIds: [], enable: 'idle' }),
    ).toEqual({ status: 'needsInstall', action: null })
  })

  it('loading: while the SDK starts and while my rows load', () => {
    expect(
      notificationsView({ device: { kind: 'loading' }, registeredIds: [], enable: 'idle' }),
    ).toEqual({ status: 'loading', action: null })
    expect(notificationsView({ device: ready, registeredIds: undefined, enable: 'idle' })).toEqual({
      status: 'loading',
      action: null,
    })
  })

  it('a failed SDK load offers «Ενεργοποίηση» (it loads again)', () => {
    expect(
      notificationsView({ device: { kind: 'failed' }, registeredIds: [], enable: 'idle' }),
    ).toEqual({ status: 'failed', action: 'enable' })
  })

  it('on (registered) → the test push is the one action', () => {
    expect(notificationsView({ device: ready, registeredIds: [DEVICE], enable: 'idle' })).toEqual({
      status: 'on',
      action: 'test',
    })
  })

  it('opted in with someone else’s row → off, «Ενεργοποίηση»', () => {
    expect(notificationsView({ device: ready, registeredIds: [OTHER], enable: 'idle' })).toEqual({
      status: 'off',
      action: 'enable',
    })
  })

  it('a failed enable says so, and «Ενεργοποίηση» stays', () => {
    const off: PushDeviceState = { kind: 'ready', facts: { ...ON, optedIn: false } }
    expect(notificationsView({ device: off, registeredIds: [], enable: 'registerFailed' })).toEqual(
      { status: 'registerFailed', action: 'enable' },
    )
    expect(notificationsView({ device: off, registeredIds: [], enable: 'failed' })).toEqual({
      status: 'failed',
      action: 'enable',
    })
  })

  it('denied or unsupported: no button (only the device settings can change it)', () => {
    const denied: PushDeviceState = { kind: 'ready', facts: { ...ON, permission: 'denied' } }
    expect(notificationsView({ device: denied, registeredIds: [], enable: 'idle' })).toEqual({
      status: 'denied',
      action: null,
    })
  })
})

describe('testPushMessage', () => {
  it.each([
    [{ queued: true, replayed: false, reason: null }, 'push.testSent'],
    [{ queued: false, replayed: true, reason: null }, 'push.testSent'],
    [{ queued: false, replayed: false, reason: 'no_subscription' }, 'push.testNotRegistered'],
    [{ queued: false, replayed: false, reason: null }, 'push.testFailed'],
  ] as const)('%o → %s', (result, expected) => {
    expect(testPushMessage(result)).toBe(expected)
  })
})
