import { describe, expect, it, vi } from 'vitest'
import { runSignOut, type AuthSignOutScope, type SignOutDeps, type SignOutResult } from './signOut'

type AuthAnswer = SignOutResult | Error

function fakeDeps(
  result: AuthAnswer = { ok: true },
  byScope: Partial<Record<AuthSignOutScope, AuthAnswer>> = {},
) {
  const calls: string[] = []
  const deps = {
    optOutPush: vi.fn(() => {
      calls.push('push')
      return Promise.resolve()
    }),
    unregisterAllPush: vi.fn(() => {
      calls.push('unregisterAll')
      return Promise.resolve()
    }),
    signOutOfSupabase: vi.fn((scope: AuthSignOutScope) => {
      calls.push(`supabase:${scope}`)
      const answer = byScope[scope] ?? result
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    }),
    clearDeviceState: vi.fn(() => {
      calls.push('clear')
    }),
  } satisfies SignOutDeps
  return { deps, calls }
}

describe('runSignOut (ADR-0009 §19, ADR-0010 §2)', () => {
  it('signs out this device only by default (scope local)', async () => {
    const { deps } = fakeDeps()
    await runSignOut(deps)
    expect(deps.signOutOfSupabase).toHaveBeenCalledWith('local')
  })

  it('an empty options object also means local', async () => {
    const { deps } = fakeDeps()
    await runSignOut(deps, {})
    expect(deps.signOutOfSupabase).toHaveBeenCalledWith('local')
  })

  it('supports "all devices" (scope global) for step 1.7: the other sessions, then this one', async () => {
    const { deps } = fakeDeps()
    await expect(runSignOut(deps, { scope: 'global' })).resolves.toEqual({ ok: true })
    expect(deps.signOutOfSupabase.mock.calls).toEqual([['others'], ['local']])
  })

  it('opts push out first, while the session still exists, then clears the device', async () => {
    const { deps, calls } = fakeDeps()
    await expect(runSignOut(deps)).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['push', 'supabase:local', 'clear'])
  })

  it('clears the device and reports it when Auth did not confirm (offline)', async () => {
    const { deps, calls } = fakeDeps({ ok: false })
    await expect(runSignOut(deps)).resolves.toEqual({ ok: false })
    expect(calls).toEqual(['push', 'supabase:local', 'clear'])
  })

  it('still signs out when the push part fails (it must never block a sign-out)', async () => {
    const { deps, calls } = fakeDeps()
    deps.optOutPush.mockImplementationOnce(() => {
      calls.push('push')
      return Promise.reject(new Error('offline'))
    })
    await expect(runSignOut(deps)).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['push', 'supabase:local', 'clear'])
  })

  it('local scope leaves the push rows of the other devices alone', async () => {
    const { deps, calls } = fakeDeps()
    await runSignOut(deps)
    expect(deps.unregisterAllPush).not.toHaveBeenCalled()
    expect(calls).toEqual(['push', 'supabase:local', 'clear'])
  })

  it('global scope: every row (p_all) before Auth, then the other sessions, then this device (contract 1.7)', async () => {
    const { deps, calls } = fakeDeps()
    await runSignOut(deps, { scope: 'global' })
    expect(calls).toEqual(['unregisterAll', 'supabase:others', 'push', 'supabase:local', 'clear'])
  })

  it('global scope waits for the unregister of every row, also when it fails', async () => {
    const { deps, calls } = fakeDeps()
    let finishUnregister: () => void = () => {}
    deps.unregisterAllPush.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          finishUnregister = () => {
            calls.push('unregisterAll')
            reject(new Error('offline'))
          }
        }),
    )
    const done = runSignOut(deps, { scope: 'global' })
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.signOutOfSupabase).not.toHaveBeenCalled()
    finishUnregister()
    await expect(done).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['unregisterAll', 'supabase:others', 'push', 'supabase:local', 'clear'])
  })

  it('a push step that throws synchronously never blocks the sign-out', async () => {
    const { deps, calls } = fakeDeps()
    deps.unregisterAllPush.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(runSignOut(deps, { scope: 'global' })).resolves.toEqual({ ok: true })
    expect(calls).toContain('supabase:others')
    expect(calls).toContain('supabase:local')
  })

  it('global scope, other sessions not confirmed (offline, 5xx): reports it and this device stays signed in', async () => {
    // Review fix (contract 1.7 §10): no silent success, and the user can try again from here.
    const { deps, calls } = fakeDeps({ ok: true }, { others: { ok: false } })
    await expect(runSignOut(deps, { scope: 'global' })).resolves.toEqual({ ok: false })
    expect(calls).toEqual(['unregisterAll', 'supabase:others'])
    expect(deps.optOutPush).not.toHaveBeenCalled()
    expect(deps.clearDeviceState).not.toHaveBeenCalled()
  })

  it('global scope: when the other sessions ended, a local call Auth did not confirm is still a success', async () => {
    // supabase-js forgets this session anyway; every other session is confirmed ended.
    const { deps, calls } = fakeDeps({ ok: true }, { local: { ok: false } })
    await expect(runSignOut(deps, { scope: 'global' })).resolves.toEqual({ ok: true })
    expect(calls).toEqual(['unregisterAll', 'supabase:others', 'push', 'supabase:local', 'clear'])
  })

  it('global scope: an Auth call that throws for the other sessions leaves this device as it was', async () => {
    const { deps } = fakeDeps({ ok: true }, { others: new Error('boom') })
    await expect(runSignOut(deps, { scope: 'global' })).rejects.toThrow('boom')
    expect(deps.clearDeviceState).not.toHaveBeenCalled()
  })

  it('clears the device even when the Supabase call throws', async () => {
    const { deps, calls } = fakeDeps(new Error('boom'))
    await expect(runSignOut(deps)).rejects.toThrow('boom')
    expect(calls).toContain('clear')
  })
})
