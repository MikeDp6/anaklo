import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCatalogue, readInitialCatalogue } from '../api'
import { testCatalogue } from '../testFixtures'
import { useCatalogue } from './useCatalogue'

vi.mock('../api', () => ({
  fetchCatalogue: vi.fn(),
  readInitialCatalogue: vi.fn(),
}))

const fetched = vi.mocked(fetchCatalogue)
const injected = vi.mocked(readInitialCatalogue)

describe('useCatalogue: a former slug (contract 1.7 §4)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/old-barber?utm_source=ig#top')
    injected.mockReturnValue(undefined)
  })
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('shows the current slug in the address bar once, keeping query and hash', async () => {
    fetched.mockResolvedValue(testCatalogue())
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useCatalogue('old-barber'))

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(
      window.history.state,
      '',
      '/demo-barber?utm_source=ig#top',
    )
    expect(window.location.pathname).toBe('/demo-barber')
    expect(fetched).toHaveBeenCalledWith('old-barber', expect.any(AbortSignal))
  })

  it('leaves the address bar alone for the current slug', async () => {
    window.history.replaceState(null, '', '/demo-barber')
    fetched.mockResolvedValue(testCatalogue())
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useCatalogue('demo-barber'))

    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('leaves it alone for an unknown slug', async () => {
    fetched.mockResolvedValue(null)
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useCatalogue('old-barber'))

    await waitFor(() => expect(result.current.state.status).toBe('not-found'))
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('needs no fetch and no correction with the injected catalogue', () => {
    injected.mockReturnValue(testCatalogue())
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useCatalogue('demo-barber'))

    expect(result.current.state.status).toBe('ready')
    expect(fetched).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })
})
