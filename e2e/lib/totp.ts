import { createHmac } from 'node:crypto'

/**
 * Codes of an authenticator app for the tests of step 1.7 (Playwright, tests/db): RFC 4226 HOTP
 * and RFC 6238 TOTP on `node:crypto`, no dependency. Supabase Auth enrols TOTP factors with the
 * authenticator defaults (SHA-1, 6 digits, 30 s step) and hands out the secret in base32, which
 * is what `totp()` takes. Secrets stay in memory: never log them.
 *
 * GoTrue accepts the code of the current step (and one step of skew). A test that verifies twice
 * must not reuse a code within one step: `msUntilNextStep` says how long to wait for a new one.
 */

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512'

export type TotpOptions = {
  /** The moment the code is for, in epoch milliseconds (default: now). */
  readonly at?: number
  /** Step in seconds (default 30). */
  readonly stepSeconds?: number
  /** Digits (default 6, the RFC's own vectors use 8). */
  readonly digits?: number
  /** HMAC hash (default SHA-1). */
  readonly algorithm?: TotpAlgorithm
}

export const DEFAULT_STEP_SECONDS = 30
const DEFAULT_DIGITS = 6
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * RFC 4648 base32, as authenticator apps read it: case-insensitive, spaces and trailing `=`
 * ignored. Any other character throws.
 */
export function decodeBase32(secret: string): Uint8Array {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase()
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value === -1) throw new Error('decodeBase32: not a base32 secret')
    buffer = ((buffer << 5) | value) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  if (bytes.length === 0) throw new Error('decodeBase32: empty secret')
  return Uint8Array.from(bytes)
}

/** RFC 4226 §5.3: HMAC of the 8-byte big-endian counter, dynamic truncation, last `digits`. */
export function hotp(
  key: Uint8Array,
  counter: number,
  digits: number = DEFAULT_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('hotp: the counter must be a non-negative integer')
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error('hotp: digits must be 6 to 10')
  }
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm, key).update(message).digest()
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return (BigInt(binary) % 10n ** BigInt(digits)).toString().padStart(digits, '0')
}

/** RFC 6238 §4.2: the step counter T = floor(unix seconds / step). */
export function totpCounter(at: number, stepSeconds: number = DEFAULT_STEP_SECONDS): number {
  if (!Number.isFinite(at) || at < 0) throw new Error('totpCounter: bad time')
  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) {
    throw new Error('totpCounter: the step must be a positive integer')
  }
  return Math.floor(Math.floor(at / 1000) / stepSeconds)
}

/** Milliseconds from `at` until the next step starts (and a new code with it). */
export function msUntilNextStep(
  at: number = Date.now(),
  stepSeconds: number = DEFAULT_STEP_SECONDS,
): number {
  return (totpCounter(at, stepSeconds) + 1) * stepSeconds * 1000 - at
}

/**
 * The code an authenticator app shows at `options.at`. `secret` is the base32 string Supabase
 * Auth returns from `mfa.enroll` (`totp.secret`), or the raw key bytes.
 */
export function totp(secret: string | Uint8Array, options: TotpOptions = {}): string {
  const key = typeof secret === 'string' ? decodeBase32(secret) : secret
  const counter = totpCounter(options.at ?? Date.now(), options.stepSeconds)
  return hotp(key, counter, options.digits, options.algorithm)
}
