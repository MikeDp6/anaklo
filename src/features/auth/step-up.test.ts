import { describe, expect, it, vi } from 'vitest'
import { failureOf, RpcFailure } from '@/shared/lib/rpcError'
import { StepUpCancelled, withStepUp, type StepUpDeps } from './step-up'

/** What PostgREST / supabase-js report for `private.require_fresh_totp()` refusals. */
const AAL2_REQUIRED = new RpcFailure({ kind: 'stepUp', hint: 'aal2_required' })
const FRESH_REQUIRED = new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' })

function deps(answer = true) {
  return {
    askForCode: vi.fn<StepUpDeps['askForCode']>(() => Promise.resolve(answer)),
    onAuthRecheck: vi.fn<StepUpDeps['onAuthRecheck']>(),
  }
}

describe('withStepUp (contract 1.7 §6.6, plan 1.7 «Frontend»)', () => {
  it('a call that succeeds never opens the sheet (no proactive opening, D18)', async () => {
    const d = deps()
    const call = vi.fn(() => Promise.resolve('done'))
    await expect(withStepUp(call, d)).resolves.toBe('done')
    expect(call).toHaveBeenCalledOnce()
    expect(d.askForCode).not.toHaveBeenCalled()
    expect(d.onAuthRecheck).not.toHaveBeenCalled()
  })

  it.each([
    ['aal2_required', AAL2_REQUIRED],
    ['fresh_totp_required', FRESH_REQUIRED],
  ] as const)('%s → the sheet once → exactly one retry', async (hint, refusal) => {
    const d = deps(true)
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValue('done')
    await expect(withStepUp(call, d)).resolves.toBe('done')
    expect(d.askForCode).toHaveBeenCalledExactlyOnceWith(hint)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('the hint also comes from a raw PostgREST error (classified on the way)', async () => {
    const d = deps(true)
    const raw = { code: '42501', message: 'a code is required', hint: 'fresh_totp_required' }
    const call = vi.fn<() => Promise<string>>().mockRejectedValueOnce(raw).mockResolvedValue('ok')
    await expect(withStepUp(call, d)).resolves.toBe('ok')
    expect(d.askForCode).toHaveBeenCalledExactlyOnceWith('fresh_totp_required')
  })

  it('a retry that fails again is final: that error, one sheet, no third call', async () => {
    const d = deps(true)
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(FRESH_REQUIRED)
      .mockRejectedValueOnce(FRESH_REQUIRED)
      .mockResolvedValue('never')
    const error: unknown = await withStepUp(call, d).catch((e: unknown) => e)
    expect(error).toBe(FRESH_REQUIRED)
    expect(d.askForCode).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('a retry that fails with another error rethrows that error', async () => {
    const d = deps(true)
    const domain = new RpcFailure({ kind: 'domain', code: 'AN001' })
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(AAL2_REQUIRED)
      .mockRejectedValueOnce(domain)
    await expect(withStepUp(call, d)).rejects.toBe(domain)
    expect(call).toHaveBeenCalledTimes(2)
    expect(d.onAuthRecheck).not.toHaveBeenCalled()
  })

  it('closing the sheet → StepUpCancelled, no retry', async () => {
    const d = deps(false)
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(FRESH_REQUIRED)
    const error: unknown = await withStepUp(call, d).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepUpCancelled)
    expect(failureOf(error)).toEqual({ kind: 'stepUpCancelled' })
    expect(call).toHaveBeenCalledOnce()
  })

  it.each([
    ['42501 without a hint', { code: '42501', message: 'not a member', hint: null }],
    ['42501 with another hint', { code: '42501', message: 'nope', hint: 'something_else' }],
    ['401', new RpcFailure({ kind: 'unauthorized' })],
    ['an expired JWT (PGRST303)', { code: 'PGRST303', message: 'JWT expired' }],
  ])('%s → no sheet, the route guards decide again, rethrown', async (_, refusal) => {
    const d = deps(true)
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(refusal)
    await expect(withStepUp(call, d)).rejects.toBe(refusal)
    expect(d.askForCode).not.toHaveBeenCalled()
    expect(d.onAuthRecheck).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledOnce()
  })

  it('a retry refused as forbidden also asks the route guards again', async () => {
    const d = deps(true)
    const forbidden = new RpcFailure({ kind: 'forbidden' })
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(FRESH_REQUIRED)
      .mockRejectedValueOnce(forbidden)
    await expect(withStepUp(call, d)).rejects.toBe(forbidden)
    expect(d.onAuthRecheck).toHaveBeenCalledOnce()
  })

  it.each([
    ['classified', new RpcFailure({ kind: 'domain', code: 'AN034' })],
    ['raw PostgREST', { code: 'P0001', message: 'AN034', hint: 'enrolment_blocked' }],
  ])(
    'adding a device blocked (AN034, %s) → rethrown: no sheet, no recheck (contract 1.9b §4.5)',
    async (_, error) => {
      const d = deps(true)
      const call = vi.fn<() => Promise<string>>().mockRejectedValue(error)
      await expect(withStepUp(call, d)).rejects.toBe(error)
      expect(failureOf(error)).toEqual({ kind: 'domain', code: 'AN034' })
      expect(d.askForCode).not.toHaveBeenCalled()
      expect(d.onAuthRecheck).not.toHaveBeenCalled()
      expect(call).toHaveBeenCalledOnce()
    },
  )

  it.each([
    ['offline', new RpcFailure({ kind: 'offline' })],
    ['a domain error', new RpcFailure({ kind: 'domain', code: 'AN027' })],
    ['anything else', new Error('boom')],
  ])('%s → rethrown, nothing else', async (_, error) => {
    const d = deps(true)
    const call = vi.fn<() => Promise<string>>().mockRejectedValue(error)
    await expect(withStepUp(call, d)).rejects.toBe(error)
    expect(d.askForCode).not.toHaveBeenCalled()
    expect(d.onAuthRecheck).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledOnce()
  })
})
