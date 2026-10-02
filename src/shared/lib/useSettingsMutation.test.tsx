import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RpcFailure } from './rpcError'
import { useSettingsMutation } from './useSettingsMutation'

// Test data only.
const BUSINESS = '00000000-0000-4000-8000-000000000001'
const KEY = ['pro', BUSINESS, 'staff'] as const

interface Vars {
  readonly id: string
  readonly name: string
}

const VARS: Vars = { id: '4f1c1e9a-7d0e-4c1b-9a51-2f3e8d7c6b5a', name: 'Ε2Ε' }

function setup<R>(
  mutationFn: (variables: Vars) => Promise<R>,
  onSuccess?: (result: R, variables: Vars) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { networkMode: 'always', retry: 0 } },
  })
  const invalidate = vi.fn(async (client: QueryClient) => {
    await client.invalidateQueries({ queryKey: KEY })
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () => useSettingsMutation<Vars, R>({ mutationFn, invalidate, onSuccess }),
    { wrapper },
  )
  return { ...hook, invalidate }
}

describe('useSettingsMutation (rule 14, contract 1.6 §3.5)', () => {
  it('shows no result before the server answers; refreshes after it', async () => {
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
    expect(result.current.succeeded).toBe(false)
    expect(invalidate).not.toHaveBeenCalled()

    act(() => answer('saved'))
    await waitFor(() => expect(result.current.result).toBe('saved'))
    expect(result.current.succeeded).toBe(true)
    expect(invalidate).toHaveBeenCalledWith(expect.any(QueryClient), VARS, 'saved')
  })

  it('offline locks the form; the retry sends the identical variables (same id)', async () => {
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
    expect(result.current.locked).toBe(true)
    await waitFor(() => expect(result.current.result).toBe('saved'))
    expect(result.current.locked).toBe(false)
    expect(mutationFn).toHaveBeenCalledTimes(2)
    expect(mutationFn.mock.calls[1]?.[0]).toBe(mutationFn.mock.calls[0]?.[0])
    expect(mutationFn.mock.calls[1]?.[0]?.id).toBe(VARS.id)
  })

  it('an upsert that inserted nothing (`[]`: an earlier attempt committed) is a success', async () => {
    const onSuccess = vi.fn()
    const mutationFn = vi.fn(() => Promise.resolve([] as string[]))
    const { result, invalidate } = setup(mutationFn, onSuccess)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.succeeded).toBe(true))
    expect(result.current.result).toEqual([])
    expect(onSuccess).toHaveBeenCalledWith([], VARS)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('an overlap does not lock and refreshes the list; an invalid value does neither', async () => {
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValueOnce(new RpcFailure({ kind: 'overlap' }))
      .mockRejectedValueOnce(new RpcFailure({ kind: 'invalid' }))
    const { result, invalidate } = setup(mutationFn)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'overlap' }))
    expect(result.current.locked).toBe(false)
    expect(invalidate).toHaveBeenCalledTimes(1)

    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'invalid' }))
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('unauthorized refreshes like forbidden; the step-up kinds neither lock nor refresh', async () => {
    // Contract 1.7 §6.6: a closed code sheet or a second refusal wrote nothing.
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValueOnce(new RpcFailure({ kind: 'unauthorized' }))
      .mockRejectedValueOnce(new RpcFailure({ kind: 'stepUpCancelled' }))
      .mockRejectedValueOnce(new RpcFailure({ kind: 'stepUp', hint: 'fresh_totp_required' }))
    const { result, invalidate } = setup(mutationFn)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'unauthorized' }))
    expect(result.current.locked).toBe(false)
    expect(invalidate).toHaveBeenCalledTimes(1)

    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'stepUpCancelled' }))
    expect(result.current.locked).toBe(false)

    act(() => result.current.submit(VARS))
    await waitFor(() =>
      expect(result.current.failure).toEqual({ kind: 'stepUp', hint: 'fresh_totp_required' }),
    )
    expect(result.current.locked).toBe(false)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('closing a locked form (`reset`) refetches what the write touches', async () => {
    const mutationFn = vi
      .fn<(variables: Vars) => Promise<string>>()
      .mockRejectedValueOnce(new RpcFailure({ kind: 'offline' }))
    const { result, invalidate } = setup(mutationFn)
    act(() => result.current.submit(VARS))
    await waitFor(() => expect(result.current.locked).toBe(true))
    expect(invalidate).not.toHaveBeenCalled()
    act(() => result.current.reset())
    expect(invalidate).toHaveBeenCalledWith(expect.any(QueryClient), VARS, undefined)
    await waitFor(() => expect(result.current.locked).toBe(false))
    expect(result.current.failure).toBeNull()
  })

  it('the caller hears of a success only while mounted; the refresh runs anyway', async () => {
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
    unmount()
    await act(() => Promise.resolve(answer('saved')))
    expect(onSuccess).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledTimes(1)
  })
})
