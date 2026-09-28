import { describe, expect, it } from 'vitest'
import { pushStatus } from './pushStatus'

describe('pushStatus', () => {
  it.each([
    [{ supported: false, permission: 'default', optedIn: false }, 'unsupported'],
    [{ supported: true, permission: null, optedIn: false }, 'unsupported'],
    [{ supported: true, permission: 'denied', optedIn: false }, 'denied'],
    [{ supported: true, permission: 'default', optedIn: false }, 'off'],
    [{ supported: true, permission: 'granted', optedIn: false }, 'off'],
    [{ supported: true, permission: 'granted', optedIn: true }, 'on'],
  ] as const)('%o → %s', (facts, expected) => {
    expect(pushStatus(facts)).toBe(expected)
  })
})
