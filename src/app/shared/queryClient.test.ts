import { describe, expect, it, vi } from 'vitest'
import { RpcFailure } from '@/shared/lib/rpcError'
import { AUTH_RECHECK_THROTTLE_MS, createQueryClient } from './queryClient'

function failingQuery(client: ReturnType<typeof createQueryClient>, key: string, error: unknown) {
  return client
    .fetchQuery({
      queryKey: [key],
      queryFn: (): Promise<never> => {
        throw error
      },
      retry: false,
    })
    .catch(() => undefined)
}

describe('createQueryClient: route guards again after a refused request (contract 1.7 §6.2)', () => {
  it('forbidden or unauthorized → one recheck per burst', async () => {
    let now = 1_000
    const onAuthFailure = vi.fn()
    const client = createQueryClient({ onAuthFailure, now: () => now })
    await failingQuery(client, 'a', new RpcFailure({ kind: 'forbidden' }))
    await failingQuery(client, 'b', { code: '42501', message: 'not a member', hint: null })
    await failingQuery(client, 'c', new RpcFailure({ kind: 'unauthorized' }))
    expect(onAuthFailure).toHaveBeenCalledOnce()
    now += AUTH_RECHECK_THROTTLE_MS
    await failingQuery(client, 'd', new RpcFailure({ kind: 'unauthorized' }))
    expect(onAuthFailure).toHaveBeenCalledTimes(2)
  })

  it('mutations count too', async () => {
    const onAuthFailure = vi.fn()
    const client = createQueryClient({ onAuthFailure })
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(new RpcFailure({ kind: 'forbidden' })) })
      .execute(undefined)
      .catch(() => undefined)
    expect(onAuthFailure).toHaveBeenCalledOnce()
  })

  it('a step-up refusal, a cancelled sheet or any other failure does not', async () => {
    const onAuthFailure = vi.fn()
    const client = createQueryClient({ onAuthFailure })
    await failingQuery(client, 'a', new RpcFailure({ kind: 'stepUp', hint: 'aal2_required' }))
    await failingQuery(client, 'b', { code: '42501', message: 'x', hint: 'fresh_totp_required' })
    await failingQuery(client, 'c', new RpcFailure({ kind: 'stepUpCancelled' }))
    await failingQuery(client, 'd', new RpcFailure({ kind: 'offline' }))
    await failingQuery(client, 'e', new RpcFailure({ kind: 'domain', code: 'AN027' }))
    expect(onAuthFailure).not.toHaveBeenCalled()
  })

  it('works without a callback (tests, other entries)', async () => {
    const client = createQueryClient()
    await expect(
      failingQuery(client, 'a', new RpcFailure({ kind: 'forbidden' })),
    ).resolves.toBeUndefined()
  })
})
