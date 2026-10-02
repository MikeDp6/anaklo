import { describe, expect, it } from 'vitest'
import elPro from '@/shared/i18n/el/pro.json'
import enPro from '@/shared/i18n/en/pro.json'
import {
  classifyRpcFailure,
  PRO_DOMAIN_ERROR_TEXTS,
  RpcFailure,
  rpcFailureMessageKey,
} from './rpcError'

describe('classifyRpcFailure (contract 1.4 §3.6)', () => {
  it('no answer = offline (outcome unknown)', () => {
    // postgrest-js turns a failed fetch into a status-0 error named after the thrown one.
    expect(
      classifyRpcFailure(
        { message: 'TypeError: Failed to fetch', code: '', details: '', hint: '' },
        0,
      ),
    ).toEqual({ kind: 'offline' })
    expect(
      classifyRpcFailure({ message: 'TimeoutError: signal timed out', code: '', hint: '' }, 0),
    ).toEqual({ kind: 'offline' })
    expect(classifyRpcFailure(new TypeError('Failed to fetch'))).toEqual({ kind: 'offline' })
    expect(classifyRpcFailure(new DOMException('timed out', 'TimeoutError'))).toEqual({
      kind: 'offline',
    })
    expect(classifyRpcFailure(new DOMException('aborted', 'AbortError'))).toEqual({
      kind: 'offline',
    })
    expect(classifyRpcFailure({ message: 'FetchError: aborted', code: '' })).toEqual({
      kind: 'offline',
    })
  })

  it('a gateway error without a SQLSTATE is offline; with one it is an answer', () => {
    expect(classifyRpcFailure({ message: 'Bad gateway', code: '' }, 502)).toEqual({
      kind: 'offline',
    })
    // A PostgREST code (PGRST…) is not a SQLSTATE: nothing says the database ran the call.
    expect(classifyRpcFailure({ message: 'x', code: 'PGRST003' }, 504)).toEqual({ kind: 'offline' })
    expect(classifyRpcFailure({ message: 'x', code: '57014' }, 503)).toEqual({ kind: 'unknown' })
  })

  it('domain codes, permission and the rest', () => {
    expect(
      classifyRpcFailure({ code: 'P0001', message: 'AN001', hint: 'slot_taken' }, 400),
    ).toEqual({
      kind: 'domain',
      code: 'AN001',
    })
    expect(classifyRpcFailure({ code: 'P0001', message: 'AN999' }, 400)).toEqual({
      kind: 'unknown',
    })
    expect(classifyRpcFailure({ code: '42501', message: 'not a member' }, 403)).toEqual({
      kind: 'forbidden',
    })
    expect(classifyRpcFailure({ code: '23505', message: 'duplicate' }, 409)).toEqual({
      kind: 'unknown',
    })
    expect(classifyRpcFailure('boom')).toEqual({ kind: 'unknown' })
    expect(classifyRpcFailure(null)).toEqual({ kind: 'unknown' })
  })

  it('an exclusion constraint is an overlap (contract 1.6 §3.6)', () => {
    expect(
      classifyRpcFailure({ code: '23P01', message: 'conflicting key value violates…' }, 409),
    ).toEqual({ kind: 'overlap' })
  })

  it.each(['23514', '22023', '22P02', '22007', '22008'])(
    'SQLSTATE %s is an invalid value (contract 1.6 §3.6)',
    (code) => {
      expect(classifyRpcFailure({ code, message: 'bad' }, 400)).toEqual({ kind: 'invalid' })
    },
  )

  it('42501 with a step-up hint is a stepUp (contract 1.7 §6.6), before forbidden', () => {
    expect(
      classifyRpcFailure(
        {
          code: '42501',
          message: 'a code from the authenticator app is required',
          hint: 'aal2_required',
        },
        403,
      ),
    ).toEqual({ kind: 'stepUp', hint: 'aal2_required' })
    expect(
      classifyRpcFailure({ code: '42501', message: 'x', hint: 'fresh_totp_required' }, 403),
    ).toEqual({ kind: 'stepUp', hint: 'fresh_totp_required' })
  })

  it('42501 without one of the two hints stays forbidden: nothing opens the sheet', () => {
    expect(classifyRpcFailure({ code: '42501', message: 'x', hint: null }, 403)).toEqual({
      kind: 'forbidden',
    })
    expect(classifyRpcFailure({ code: '42501', message: 'x', hint: '' }, 403)).toEqual({
      kind: 'forbidden',
    })
    expect(classifyRpcFailure({ code: '42501', message: 'x', hint: 'aal2' }, 403)).toEqual({
      kind: 'forbidden',
    })
    // A hint on another SQLSTATE is not a step-up either.
    expect(classifyRpcFailure({ code: '22023', message: 'x', hint: 'aal2_required' }, 400)).toEqual(
      { kind: 'invalid' },
    )
  })

  it('401 and an invalid or expired JWT are unauthorized', () => {
    expect(classifyRpcFailure({ code: '42501', message: 'permission denied' }, 401)).toEqual({
      kind: 'unauthorized',
    })
    expect(classifyRpcFailure({ code: 'PGRST301', message: 'JWSError' }, 401)).toEqual({
      kind: 'unauthorized',
    })
    expect(classifyRpcFailure({ code: 'PGRST303', message: 'JWT expired' })).toEqual({
      kind: 'unauthorized',
    })
    expect(classifyRpcFailure({}, 401)).toEqual({ kind: 'unauthorized' })
  })

  it('an RpcFailure keeps its classification', () => {
    const failure = new RpcFailure({ kind: 'domain', code: 'AN020' })
    expect(classifyRpcFailure(failure)).toEqual({ kind: 'domain', code: 'AN020' })
  })
})

describe('rpcFailureMessageKey', () => {
  it('a write and a read say «offline» differently', () => {
    expect(rpcFailureMessageKey({ kind: 'offline' })).toBe('pro:errors.offline')
    expect(rpcFailureMessageKey({ kind: 'offline' }, 'read')).toBe('common:errors.network')
  })

  it('domain codes use the pro text when there is one, else the common one', () => {
    expect(rpcFailureMessageKey({ kind: 'domain', code: 'AN001' })).toBe('pro:errors.AN001')
    expect(rpcFailureMessageKey({ kind: 'domain', code: 'AN005' })).toBe('common:errors.AN005')
    expect(rpcFailureMessageKey({ kind: 'forbidden' })).toBe('pro:errors.forbidden')
    expect(rpcFailureMessageKey({ kind: 'unknown' })).toBe('common:errors.unknown')
  })

  it('the step-up kinds have their texts; unauthorized says forbidden', () => {
    expect(rpcFailureMessageKey({ kind: 'stepUp', hint: 'fresh_totp_required' })).toBe(
      'pro:stepUp.failed',
    )
    expect(rpcFailureMessageKey({ kind: 'stepUpCancelled' })).toBe('pro:stepUp.cancelled')
    expect(rpcFailureMessageKey({ kind: 'unauthorized' })).toBe('pro:errors.forbidden')
  })

  it('overlap, invalid and gone have their pro texts', () => {
    expect(rpcFailureMessageKey({ kind: 'overlap' })).toBe('pro:errors.overlap')
    expect(rpcFailureMessageKey({ kind: 'invalid' })).toBe('pro:errors.invalid')
    expect(rpcFailureMessageKey({ kind: 'gone' })).toBe('pro:errors.gone')
  })
})

describe('pro error texts', () => {
  it('every pro override and pro failure has a text in both languages', () => {
    for (const catalogue of [elPro.errors, enPro.errors]) {
      for (const key of [
        ...PRO_DOMAIN_ERROR_TEXTS,
        'offline',
        'forbidden',
        'overlap',
        'invalid',
        'gone',
      ] as const) {
        expect(catalogue[key]).toEqual(expect.any(String))
      }
      expect(catalogue).toBeDefined()
    }
    for (const catalogue of [elPro.stepUp, enPro.stepUp]) {
      expect(catalogue.failed).toEqual(expect.any(String))
      expect(catalogue.cancelled).toEqual(expect.any(String))
    }
  })
})
