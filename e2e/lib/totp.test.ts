// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeBase32, hotp, msUntilNextStep, totp, totpCounter, type TotpAlgorithm } from './totp'

/**
 * The generator of e2e/lib/totp.ts against the published vectors: RFC 6238 Appendix B (TOTP,
 * 8 digits, SHA-1/256/512 with the RFC's ASCII seeds) and RFC 4226 Appendix D (HOTP, 6 digits).
 * Runs in `npm test` (vitest.config.ts includes e2e/lib/*.test.ts; Playwright only runs *.spec.ts).
 */

const ascii = (text: string) => new TextEncoder().encode(text)

/** RFC 6238 Appendix B: one seed per hash, 20/32/64 bytes. */
const SEEDS: Record<TotpAlgorithm, Uint8Array> = {
  sha1: ascii('12345678901234567890'),
  sha256: ascii('12345678901234567890123456789012'),
  sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
}

/** RFC 6238 Appendix B: unix seconds, T (hex), then the 8-digit TOTP for SHA-1, SHA-256, SHA-512. */
const RFC6238_VECTORS: ReadonlyArray<readonly [number, string, string, string, string]> = [
  [59, '0000000000000001', '94287082', '46119246', '90693936'],
  [1111111109, '00000000023523EC', '07081804', '68084774', '25091201'],
  [1111111111, '00000000023523ED', '14050471', '67062674', '99943326'],
  [1234567890, '000000000273EF07', '89005924', '91819424', '93441116'],
  [2000000000, '0000000003F940AA', '69279037', '90698825', '38618901'],
  [20000000000, '0000000027BC86AA', '65353130', '77737706', '47863826'],
]

/** RFC 4226 Appendix D: HOTP of the SHA-1 seed for counters 0 to 9. */
const RFC4226_VECTORS = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
] as const

/** base32 of the SHA-1 seed «12345678901234567890». */
const SHA1_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('RFC 6238 Appendix B', () => {
  it.each(RFC6238_VECTORS)('t = %i s (T = %s)', (seconds, counterHex, sha1, sha256, sha512) => {
    const at = seconds * 1000
    expect(totpCounter(at)).toBe(Number.parseInt(counterHex, 16))
    expect(totp(SEEDS.sha1, { at, digits: 8, algorithm: 'sha1' })).toBe(sha1)
    expect(totp(SEEDS.sha256, { at, digits: 8, algorithm: 'sha256' })).toBe(sha256)
    expect(totp(SEEDS.sha512, { at, digits: 8, algorithm: 'sha512' })).toBe(sha512)
  })
})

describe('RFC 4226 Appendix D', () => {
  it.each(RFC4226_VECTORS.map((code, counter) => [counter, code] as const))(
    'counter %i → %s',
    (counter, code) => {
      expect(hotp(SEEDS.sha1, counter)).toBe(code)
    },
  )
})

describe('totp with a base32 secret (what Supabase Auth returns)', () => {
  it('decodes base32 to the raw seed, ignoring case, spaces and padding', () => {
    expect(decodeBase32(SHA1_SEED_BASE32)).toEqual(SEEDS.sha1)
    expect(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(SEEDS.sha1)
    expect(decodeBase32('MY======')).toEqual(ascii('f'))
  })

  it('defaults to SHA-1, 6 digits and a 30 s step: the last 6 digits of the RFC vector', () => {
    expect(totp(SHA1_SEED_BASE32, { at: 59_000 })).toBe('287082')
    expect(totp(SHA1_SEED_BASE32, { at: 1_111_111_109_000 })).toBe('081804')
    expect(totp(SHA1_SEED_BASE32, { at: 2_000_000_000_000 })).toBe('279037')
  })

  it('gives the same code within a step and a new one at the next step', () => {
    const start = 1_111_111_110_000 // a step boundary: 1111111110 = 30 × 37037037
    expect(msUntilNextStep(start)).toBe(30_000)
    expect(msUntilNextStep(start + 29_999)).toBe(1)
    expect(totp(SHA1_SEED_BASE32, { at: start })).toBe(
      totp(SHA1_SEED_BASE32, { at: start + 29_999 }),
    )
    expect(totpCounter(start + 30_000)).toBe(totpCounter(start) + 1)
  })

  it('refuses what is not a base32 secret or a usable counter', () => {
    expect(() => decodeBase32('not-base32!')).toThrow()
    expect(() => decodeBase32('')).toThrow()
    expect(() => decodeBase32('0189')).toThrow()
    expect(() => hotp(SEEDS.sha1, -1)).toThrow()
    expect(() => hotp(SEEDS.sha1, 0, 5)).toThrow()
    expect(() => totpCounter(Number.NaN)).toThrow()
  })
})
