// TEMPORARY (spike until the 1.10 device tests): see ./api.ts.
import { useCallback, useEffect, useState } from 'react'
import { checkTrustedDevice, type SpikeTdStatus } from './api'

/** One check on open and one per «check again»; no TanStack Query on the booking page. */
export function useTrustedDeviceSpike() {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ attempt: number; data: SpikeTdStatus | null } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    checkTrustedDevice(controller.signal).then(
      (data) => setResult({ attempt, data }),
      () => {
        if (!controller.signal.aborted) setResult({ attempt, data: null })
      },
    )
    return () => controller.abort()
  }, [attempt])

  const refetch = useCallback(() => setAttempt((value) => value + 1), [])
  const isFetching = result?.attempt !== attempt
  return {
    isFetching,
    isError: !isFetching && result?.data === null,
    data: isFetching ? undefined : (result?.data ?? undefined),
    refetch,
  }
}
