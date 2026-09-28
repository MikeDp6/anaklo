/**
 * Base64url (RFC 4648 §5) without padding, for random tokens: the trusted-device token
 * (ADR-0006, 32 bytes → 43 chars) and later the manage link (16 bytes → 22 chars, ADR-0008 §8).
 * Pure: the caller gets the random bytes (`crypto.getRandomValues`) in its runtime.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += ALPHABET[(triple >> 18) & 63]
    out += ALPHABET[(triple >> 12) & 63]
    if (i + 1 < bytes.length) out += ALPHABET[(triple >> 6) & 63]
    if (i + 2 < bytes.length) out += ALPHABET[triple & 63]
  }
  return out
}

/** Length of the unpadded base64url text for `byteCount` bytes. */
export function base64UrlLength(byteCount: number): number {
  return Math.ceil((byteCount * 4) / 3)
}

/** True when `value` is exactly the unpadded base64url encoding of `byteCount` bytes. */
export function isBase64UrlOfLength(value: string | null | undefined, byteCount: number) {
  if (typeof value !== 'string' || value.length !== base64UrlLength(byteCount)) return false
  return /^[A-Za-z0-9_-]+$/.test(value)
}
