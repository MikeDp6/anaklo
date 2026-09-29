import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testWorkspace } from '@/features/appointments/testFixtures'
import { RpcFailure } from '@/shared/lib/rpcError'
import { useWorkspace } from './useWorkspace'

const workspace = testWorkspace()

vi.mock('@/features/auth/hooks/useMember', () => ({
  useMember: () => ({ membership: testWorkspace().membership }),
}))
const settingsApi = vi.hoisted(() => ({ fetchBusiness: vi.fn() }))
vi.mock('@/features/settings/api', () => settingsApi)
const staffApi = vi.hoisted(() => ({ fetchStaff: vi.fn() }))
vi.mock('@/features/staff/api', () => staffApi)
const servicesApi = vi.hoisted(() => ({ fetchServices: vi.fn() }))
vi.mock('@/features/services/api', () => servicesApi)

afterEach(() => {
  vi.clearAllMocks()
})

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, ...renderHook(() => useWorkspace(), { wrapper }) }
}

describe('useWorkspace', () => {
  it('a failed background refetch keeps the workspace ready (the screen and its sheet stay)', async () => {
    settingsApi.fetchBusiness.mockResolvedValue(workspace.business)
    staffApi.fetchStaff.mockResolvedValue(workspace.staff)
    servicesApi.fetchServices.mockResolvedValue(workspace.services)
    const { result, queryClient } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    // Back from another app on a weak signal: the focus refetch of the business fails.
    settingsApi.fetchBusiness.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    await act(() => queryClient.refetchQueries())
    expect(queryClient.getQueryState(['pro', workspace.businessId, 'business'])?.status).toBe(
      'error',
    )
    // TanStack Query tells the component on the next tick: let that render happen first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(result.current.status).toBe('ready')
  })

  it('a query that never loaded is an error with a retry', async () => {
    settingsApi.fetchBusiness.mockRejectedValue(new RpcFailure({ kind: 'offline' }))
    staffApi.fetchStaff.mockResolvedValue(workspace.staff)
    servicesApi.fetchServices.mockResolvedValue(workspace.services)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toMatchObject({ failure: { kind: 'offline' } })
  })
})
