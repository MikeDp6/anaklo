import { afterEach, describe, expect, it, vi } from 'vitest'
import { readSupportContact, supportContact } from './env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('support contact (contract 1.7 D19)', () => {
  it('a valid email and phone (stored as E.164)', () => {
    expect(supportContact(' support@example.com ', '210 000 0000')).toEqual({
      email: 'support@example.com',
      phone: '+302100000000',
    })
  })

  it('missing or malformed values are null (the link is hidden), never an error', () => {
    expect(supportContact(undefined, undefined)).toEqual({ email: null, phone: null })
    expect(supportContact('', '')).toEqual({ email: null, phone: null })
    expect(supportContact('not an email', 'call us')).toEqual({ email: null, phone: null })
  })

  it('reads VITE_SUPPORT_EMAIL and VITE_SUPPORT_PHONE', () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com')
    vi.stubEnv('VITE_SUPPORT_PHONE', '+302100000000')
    expect(readSupportContact()).toEqual({ email: 'support@example.com', phone: '+302100000000' })
  })
})
