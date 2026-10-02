import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { withStepUp } from '@/features/auth/step-up'
import { throwIfFunctionFailed } from './functionError'
import { failureOf, RpcFailure } from './rpcError'

function httpError(status: number, body: unknown): FunctionsHttpError {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new FunctionsHttpError(
    new Response(text, { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

async function failureFrom(error: unknown) {
  try {
    await throwIfFunctionFailed(error)
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcFailure)
    return failureOf(thrown)
  }
  return null
}

describe('throwIfFunctionFailed (contract 1.7 §6.6, D12)', () => {
  it('no error → nothing thrown', async () => {
    await expect(throwIfFunctionFailed(null)).resolves.toBeUndefined()
    await expect(throwIfFunctionFailed(undefined)).resolves.toBeUndefined()
  })

  it('403 with a step-up hint is a stepUp, exactly like the RPC', async () => {
    await expect(
      failureFrom(
        httpError(403, { code: '42501', message: 'code required', hint: 'fresh_totp_required' }),
      ),
    ).resolves.toEqual({ kind: 'stepUp', hint: 'fresh_totp_required' })
    await expect(
      failureFrom(
        httpError(403, { code: '42501', message: 'code required', hint: 'aal2_required' }),
      ),
    ).resolves.toEqual({ kind: 'stepUp', hint: 'aal2_required' })
  })

  it('403 without a hint is forbidden (manager, another business, a foreign device)', async () => {
    await expect(
      failureFrom(httpError(403, { code: '42501', message: 'not the owner', hint: null })),
    ).resolves.toEqual({ kind: 'forbidden' })
  })

  it('the last device (AN027, 403) is the domain error with its own text', async () => {
    await expect(
      failureFrom(httpError(403, { code: 'P0001', message: 'AN027', hint: 'last_factor' })),
    ).resolves.toEqual({ kind: 'domain', code: 'AN027' })
  })

  it('409 domain errors pass through (AN028)', async () => {
    await expect(
      failureFrom(httpError(409, { code: 'P0001', message: 'AN028', hint: 'already_member' })),
    ).resolves.toEqual({ kind: 'domain', code: 'AN028' })
  })

  it('401 (no bearer, or the relay refused the JWT) is unauthorized', async () => {
    await expect(
      failureFrom(httpError(401, { code: 'unauthorized', message: 'no bearer', hint: null })),
    ).resolves.toEqual({ kind: 'unauthorized' })
    await expect(
      failureFrom(httpError(401, { code: 401, message: 'Invalid JWT' })),
    ).resolves.toEqual({ kind: 'unauthorized' })
  })

  it('a body of another shape is classified by its status only', async () => {
    await expect(failureFrom(httpError(400, 'not json'))).resolves.toEqual({ kind: 'unknown' })
    await expect(failureFrom(httpError(502, { error: 'bad gateway' }))).resolves.toEqual({
      kind: 'offline',
    })
  })

  it('no answer → offline; the relay or anything else → unknown', async () => {
    await expect(
      failureFrom(new FunctionsFetchError(new TypeError('Failed to fetch'))),
    ).resolves.toEqual({ kind: 'offline' })
    await expect(
      failureFrom(new FunctionsRelayError(new Response('', { status: 500 }))),
    ).resolves.toEqual({ kind: 'unknown' })
    await expect(failureFrom(new Error('boom'))).resolves.toEqual({ kind: 'unknown' })
  })

  it('through withStepUp: the 403 opens the sheet and the call runs once more', async () => {
    const askForCode = vi.fn(() => Promise.resolve(true))
    const onAuthRecheck = vi.fn()
    let calls = 0
    const invoke = async () => {
      calls += 1
      if (calls === 1) {
        await throwIfFunctionFailed(
          httpError(403, { code: '42501', message: 'code required', hint: 'fresh_totp_required' }),
        )
      }
      return 'removed'
    }
    await expect(withStepUp(invoke, { askForCode, onAuthRecheck })).resolves.toBe('removed')
    expect(askForCode).toHaveBeenCalledExactlyOnceWith('fresh_totp_required')
    expect(calls).toBe(2)
    expect(onAuthRecheck).not.toHaveBeenCalled()
  })

  it('through withStepUp: a 403 without a hint never opens the sheet', async () => {
    const askForCode = vi.fn(() => Promise.resolve(true))
    const onAuthRecheck = vi.fn()
    const invoke = async () => {
      await throwIfFunctionFailed(httpError(403, { code: '42501', message: 'no', hint: null }))
      return 'never'
    }
    await expect(withStepUp(invoke, { askForCode, onAuthRecheck })).rejects.toBeInstanceOf(
      RpcFailure,
    )
    expect(askForCode).not.toHaveBeenCalled()
    expect(onAuthRecheck).toHaveBeenCalledOnce()
  })
})
