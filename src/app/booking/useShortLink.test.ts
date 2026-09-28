import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useShortLink } from './useShortLink'

const api = vi.hoisted(() => ({ resolveShortCode: vi.fn() }))
vi.mock('@/features/booking/api', () => api)

const go = vi.fn()

beforeEach(() => {
  api.resolveShortCode.mockReset()
  go.mockReset()
})

describe('useShortLink (/r/<code> resolved by the page)', () => {
  it('goes to the booking page of the slug', async () => {
    api.resolveShortCode.mockResolvedValue('demo-barber')
    const { result } = renderHook(() => useShortLink('demo01', go))
    await waitFor(() => expect(go).toHaveBeenCalledWith('/demo-barber'))
    expect(result.current.state).toBe('loading')
  })

  it('never leaves for anything but a booking page of this site', async () => {
    api.resolveShortCode.mockResolvedValue('//evil.example')
    const { result } = renderHook(() => useShortLink('demo01', go))
    await waitFor(() => expect(result.current.state).toBe('not-found'))
    expect(go).not.toHaveBeenCalled()
  })

  it('an unknown code is not found; a failure can be retried', async () => {
    api.resolveShortCode.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null)
    const { result } = renderHook(() => useShortLink('demo01', go))
    await waitFor(() => expect(result.current.state).toBe('error'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state).toBe('not-found'))
    expect(api.resolveShortCode).toHaveBeenCalledTimes(2)
  })
})
