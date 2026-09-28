// TEMPORARY (step 1.1 spike): see ./api.ts.
import { useQuery } from '@tanstack/react-query'
import { checkTrustedDevice } from './api'

export function useTrustedDeviceSpike() {
  return useQuery({
    queryKey: ['spike-td'],
    queryFn: ({ signal }) => checkTrustedDevice(signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}
