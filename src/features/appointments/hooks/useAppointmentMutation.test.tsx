import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RpcFailure } from '@/shared/lib/rpcError'
import { useAppointmentMutation } from './useAppointmentMutation'

// Test data only.
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const ZONE = 'Europe/Athens'

interface Vars {
  readonly idempotencyKey: string
  readonly startsAt: string
}

function setup(
  mutationFn: (variables: Vars) => Promise<string>,
  onSuccess?: (result: string, variables: Vars) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { networkMode: 'always', retry: 0 } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () =>
      useAppointmentMutation<Vars, string>({
        businessId: BUSINESS,
        timeZone: ZONE,
        mutationFn,
        instantsOf: (variables) => [variables.startsAt],
        onSuccess,
      }),
    { wrapper },
  )
  return { ...hook, invalidate }
}

const VARS: Vars = {
  idempotencyKey: '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a',
  startsAt: '2026-09-29T07:00:00Z',
}

describe('useAppointmentMutation (rule 14, contract 1.4 §3.5)', () => {
  it('after «χωρίς σύνδεση» the form locks; the retry resends the identical variables (same key)', async () => {
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce('saved')
    const { result } = setup(mutationFn)

    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.locked).toBe(true))
    expect(result.current.failure).toEqual({ kind: 'offline' })
    expect(result.current.result).toBeNull()

    act(() => result.current.retry())
    // Still locked while the retry runs: the outcome is unknown until the server answers.
    expect(result.current.locked).toBe(true)
    await waitFor(() => expect(result.current.result).toBe('saved'))
    expect(result.current.locked).toBe(false)

    expect(mutationFn).toHaveBeenCalledTimes(2)
    expect(mutationFn.mock.calls[1]?.[0]).toBe(mutationFn.mock.calls[0]?.[0])
    expect(mutationFn.mock.calls[1]?.[0]?.idempotencyKey).toBe(VARS.idempotencyKey)
  })

  it('shows no success before the server answers and refreshes the day after it', async () => {
    let answer: (value: string) => void = () => {}
    const mutationFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
    )
    const { result, invalidate } = setup(mutationFn)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.pending).toBe(true))
    expect(result.current.result).toBeNull()
    expect(invalidate).not.toHaveBeenCalled()

    act(() => answer('saved'))
    await waitFor(() => expect(result.current.result).toBe('saved'))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pro', BUSINESS, 'day', '2026-09-29'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pro', BUSINESS, 'today'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pro', BUSINESS, 'slots'] })
  })

  it('the caller hears of a success only while mounted; a late answer never acts on another sheet', async () => {
    let answer: (value: string) => void = () => {}
    const mutationFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve
        }),
    )
    const onSuccess = vi.fn()
    const { result, unmount, invalidate } = setup(mutationFn, onSuccess)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.pending).toBe(true))

    // The sheet is closed (and another one may be open) before the server answers.
    unmount()
    await act(() => Promise.resolve(answer('saved')))

    expect(onSuccess).not.toHaveBeenCalled()
    // The day still refreshes: the change was saved.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pro', BUSINESS, 'day', '2026-09-29'] })
  })

  it('while mounted the caller hears of the success, also of a retry after «χωρίς σύνδεση»', async () => {
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
      .mockResolvedValueOnce('saved')
    const onSuccess = vi.fn()
    const { result } = setup(mutationFn, onSuccess)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.locked).toBe(true))
    expect(onSuccess).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(onSuccess.mock.calls[0]?.[0]).toBe('saved')
  })

  it('a domain error does not lock; AN001 (taken meanwhile) refreshes the day', async () => {
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValue(new RpcFailure({ kind: 'domain', code: 'AN001' }))
    const { result, invalidate } = setup(mutationFn)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'domain', code: 'AN001' }))
    expect(result.current.locked).toBe(false)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['pro', BUSINESS, 'day', '2026-09-29'] })
  })
})
