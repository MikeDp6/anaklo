// @vitest-environment node
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { base64UrlLength, isBase64UrlOfLength, toBase64Url } from './base64url.ts'

describe('toBase64Url', () => {
  it('matches the RFC 4648 test vectors, without padding', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ]
    for (const [input, expected] of vectors) {
      expect(toBase64Url(new TextEncoder().encode(input))).toBe(expected)
    }
  })

  it('uses - and _ instead of + and /', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_')
  })

  it('matches Node for random input of every length', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = new Uint8Array(randomBytes(length))
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    }
  })
})

describe('isBase64UrlOfLength', () => {
  it('accepts only the exact length and alphabet', () => {
    const token = toBase64Url(new Uint8Array(randomBytes(32)))
    expect(base64UrlLength(32)).toBe(43)
    expect(base64UrlLength(16)).toBe(22)
    expect(isBase64UrlOfLength(token, 32)).toBe(true)
    expect(isBase64UrlOfLength(`${token}A`, 32)).toBe(false)
    expect(isBase64UrlOfLength(token.slice(1), 32)).toBe(false)
    expect(isBase64UrlOfLength(`${token.slice(1)}=`, 32)).toBe(false)
    expect(isBase64UrlOfLength(`${token.slice(1)}+`, 32)).toBe(false)
    expect(isBase64UrlOfLength(null, 32)).toBe(false)
    expect(isBase64UrlOfLength(undefined, 32)).toBe(false)
  })
})
