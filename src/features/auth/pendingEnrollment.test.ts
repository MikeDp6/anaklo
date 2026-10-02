import { describe, expect, it } from 'vitest'
import {
  clearPendingEnrollment,
  PENDING_ENROLLMENT_TTL_MS,
  readPendingEnrollment,
  savePendingEnrollment,
  type PendingEnrollment,
} from './pendingEnrollment'
import { memoryStorage } from './storage'

// Synthetic ids (demo seed users).
const USER = '00000000-0000-4000-8000-00000000a013'
const OTHER = '00000000-0000-4000-8000-00000000a014'
const FACTOR = '6f9619ff-8b86-4011-b42d-00c04fc964ff'
const KEY = 'anaklo.pro.pendingEnrollment'
const NOW = new Date('2026-10-02T09:00:00Z')

const ENTRY: PendingEnrollment = {
  userId: USER,
  factorId: FACTOR,
  friendlyName: 'Συσκευή 1',
  mode: 'first',
  stage: 'scan',
  createdAt: NOW.getTime(),
}

describe('pending enrolment (contract 1.7 §6.4, D15)', () => {
  it('round-trips factor, name, mode and stage', () => {
    const storage = memoryStorage()
    savePendingEnrollment(storage, ENTRY)
    expect(readPendingEnrollment(storage, USER, NOW)).toEqual(ENTRY)
  })

  it('never stores the secret, the QR or the otpauth URI', () => {
    const storage = memoryStorage()
    const withSecrets = {
      ...ENTRY,
      secret: 'JBSWY3DPEHPK3PXP',
      qrDataUri: 'data:image/svg+xml;utf-8,<svg/>',
      uri: 'otpauth://totp/Anaklo:owner?secret=JBSWY3DPEHPK3PXP',
    }
    savePendingEnrollment(storage, withSecrets)
    const raw = storage.getItem(KEY) ?? ''
    expect(raw).not.toContain('JBSWY3DPEHPK3PXP')
    expect(raw).not.toContain('otpauth')
    expect(raw).not.toContain('svg')
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'createdAt',
      'factorId',
      'friendlyName',
      'mode',
      'stage',
      'userId',
    ])
  })

  it('expires after 30 minutes (and is removed)', () => {
    const storage = memoryStorage()
    savePendingEnrollment(storage, ENTRY)
    const justBefore = new Date(NOW.getTime() + PENDING_ENROLLMENT_TTL_MS)
    expect(readPendingEnrollment(storage, USER, justBefore)).toEqual(ENTRY)
    const after = new Date(NOW.getTime() + PENDING_ENROLLMENT_TTL_MS + 1)
    expect(readPendingEnrollment(storage, USER, after)).toBeNull()
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('another user (a shared phone) is ignored and the entry left for its owner', () => {
    const storage = memoryStorage()
    savePendingEnrollment(storage, ENTRY)
    expect(readPendingEnrollment(storage, OTHER, NOW)).toBeNull()
    expect(readPendingEnrollment(storage, USER, NOW)).toEqual(ENTRY)
  })

  it('an unreadable entry is removed', () => {
    const storage = memoryStorage()
    storage.setItem(KEY, '{not json')
    expect(readPendingEnrollment(storage, USER, NOW)).toBeNull()
    expect(storage.getItem(KEY)).toBeNull()
    storage.setItem(KEY, JSON.stringify({ ...ENTRY, mode: 'other' }))
    expect(readPendingEnrollment(storage, USER, NOW)).toBeNull()
  })

  it('clears; works without storage at all', () => {
    const storage = memoryStorage()
    savePendingEnrollment(storage, ENTRY)
    clearPendingEnrollment(storage)
    expect(readPendingEnrollment(storage, USER, NOW)).toBeNull()
    expect(() => savePendingEnrollment(null, ENTRY)).not.toThrow()
    expect(readPendingEnrollment(null, USER, NOW)).toBeNull()
  })
})
