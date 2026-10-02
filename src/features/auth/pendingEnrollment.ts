import { z } from 'zod/mini'
import { readItem, removeItem, writeItem, type KeyValueStorage } from './storage'

/**
 * An enrolment in progress (plan 1.7 «Εγγραφή», contract 1.7 §6.4, D15). The installed iOS app
 * may reload while the user is in the authenticator app; on return the wizard resumes from here.
 * Kept in sessionStorage and NEVER with the secret, the QR or the `otpauth://` URI: only which
 * factor, its name, the wizard's mode and stage. A resume at the QR stage starts over (the QR
 * cannot be shown again); at the code stage it asks for the code of that factor.
 */
const PENDING_ENROLLMENT_KEY = 'anaklo.pro.pendingEnrollment'

/** After this the enrolment is abandoned (its factor is removed on the next start). */
export const PENDING_ENROLLMENT_TTL_MS = 30 * 60 * 1000

export const ENROLL_MODES = ['first', 'second', 'add'] as const
export type EnrollMode = (typeof ENROLL_MODES)[number]
export type EnrollStage = 'scan' | 'code'

const StoredPendingEnrollment = z.object({
  userId: z.string(),
  factorId: z.string(),
  friendlyName: z.string(),
  mode: z.enum(ENROLL_MODES),
  stage: z.enum(['scan', 'code']),
  createdAt: z.number(),
})

export interface PendingEnrollment {
  readonly userId: string
  readonly factorId: string
  readonly friendlyName: string
  readonly mode: EnrollMode
  readonly stage: EnrollStage
  /** Epoch milliseconds. */
  readonly createdAt: number
}

export function savePendingEnrollment(
  storage: KeyValueStorage | null,
  entry: PendingEnrollment,
): void {
  // Field by field: nothing else (a secret by mistake) can reach the storage.
  const value: PendingEnrollment = {
    userId: entry.userId,
    factorId: entry.factorId,
    friendlyName: entry.friendlyName,
    mode: entry.mode,
    stage: entry.stage,
    createdAt: entry.createdAt,
  }
  writeItem(storage, PENDING_ENROLLMENT_KEY, JSON.stringify(value))
}

/**
 * The enrolment in progress of `userId`, or null. Expired or unreadable entries are removed; an
 * entry of another user (a shared phone) is ignored and left for that user.
 */
export function readPendingEnrollment(
  storage: KeyValueStorage | null,
  userId: string,
  now: Date,
): PendingEnrollment | null {
  const raw = readItem(storage, PENDING_ENROLLMENT_KEY)
  if (raw === null) return null
  const parsed = StoredPendingEnrollment.safeParse(parseJson(raw))
  if (!parsed.success || now.getTime() - parsed.data.createdAt > PENDING_ENROLLMENT_TTL_MS) {
    clearPendingEnrollment(storage)
    return null
  }
  return parsed.data.userId === userId ? parsed.data : null
}

export function clearPendingEnrollment(storage: KeyValueStorage | null): void {
  removeItem(storage, PENDING_ENROLLMENT_KEY)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
