import { describe, expect, it, vi } from 'vitest'
import { runSignOut, type SignOutDeps, type SignOutResult } from './signOut'

function fakeDeps(result: SignOutResult | Error = { ok: true }) {
  const calls: string[] = []
  const deps = {
    optOutPush: vi.fn(() => {
      calls.push('push')
      return Promise.resolve()
    }),
    signOutOfSupabase: vi.fn((scope: string) => {
      calls.push(`supabase:${scope}`)
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
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

  it('supports "all devices" (scope global) for step 1.7', async () => {
    const { deps } = fakeDeps()
    await runSignOut(deps, { scope: 'global' })
    expect(deps.signOutOfSupabase).toHaveBeenCalledWith('global')
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

  it('clears the device even when the Supabase call throws', async () => {
    const { deps, calls } = fakeDeps(new Error('boom'))
    await expect(runSignOut(deps)).rejects.toThrow('boom')
    expect(calls).toContain('clear')
  })
})
