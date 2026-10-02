import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import type { StepUpHint } from '@/shared/lib/domain'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { getSessionUser } from '../api'
import { listVerifiedFactors, type VerifiedFactor } from '../mfaApi'
import type { StepUpDeps } from '../step-up'

/** Same pace as the query client's recheck: one new route decision per burst. */
const RECHECK_THROTTLE_MS = 5_000

export interface StepUpRequest {
  readonly hint: StepUpHint
  readonly factors: readonly VerifiedFactor[]
}

/**
 * State behind `StepUpProvider` (contract 1.7 §6.6): `askForCode` opens one sheet for every
 * caller at that moment (concurrent requests share it and its answer); it resolves true once a
 * code was verified, false when the sheet was closed. Without a verified device there is nothing
 * to ask: false, and the route guards decide again (enrolment). The devices are read fresh.
 */
export function useStepUpController() {
  const queryClient = useQueryClient()
  const { revalidate } = useRevalidator()
  const [request, setRequest] = useState<StepUpRequest | null>(null)
  const pending = useRef<Promise<boolean> | null>(null)
  const settle = useRef<((verified: boolean) => void) | null>(null)
  const lastRecheck = useRef(Number.NEGATIVE_INFINITY)

  const onAuthRecheck = useCallback(() => {
    const now = Date.now()
    if (now - lastRecheck.current < RECHECK_THROTTLE_MS) return
    lastRecheck.current = now
    void revalidate()
  }, [revalidate])

  const open = useCallback(
    async (hint: StepUpHint): Promise<boolean> => {
      const user = await getSessionUser()
      if (!user) {
        onAuthRecheck()
        return false
      }
      const factors = await queryClient.fetchQuery({
        queryKey: proKeys.mfaFactors(user.userId),
        queryFn: listVerifiedFactors,
        staleTime: 0,
      })
      if (factors.length === 0) {
        onAuthRecheck()
        return false
      }
      return new Promise<boolean>((resolve) => {
        settle.current = resolve
        setRequest({ hint, factors })
      })
    },
    [queryClient, onAuthRecheck],
  )

  const askForCode = useCallback(
    (hint: StepUpHint): Promise<boolean> => {
      pending.current ??= open(hint).finally(() => {
        pending.current = null
      })
      return pending.current
    },
    [open],
  )

  const finish = useCallback((verified: boolean) => {
    setRequest(null)
    settle.current?.(verified)
    settle.current = null
  }, [])

  const deps = useMemo<StepUpDeps>(
    () => ({ askForCode, onAuthRecheck }),
    [askForCode, onAuthRecheck],
  )
  return { deps, request, finish } as const
}
