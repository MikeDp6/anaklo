import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate, useRevalidator } from 'react-router'
import { onSignedOut } from '../api'
import { LOGIN_PATH } from '../loaders'
import { cleanUpDevice } from '../session'

/** Focus and visibility events can fire in bursts; one check per burst is enough. */
const RESUME_THROTTLE_MS = 5_000

/**
 * App-wide session watch (ADR-0009 §10, §19):
 * - on every return to the app the route loaders run again: the 30-day check, then the new
 *   activity timestamp, then the membership read live from the database;
 * - when supabase-js drops the session (revoked, or signed out in another tab), the device is
 *   cleaned up like on a sign-out and the login screen opens.
 */
export function useSessionEvents(): void {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { revalidate } = useRevalidator()

  useEffect(() => {
    const unsubscribe = onSignedOut(() => {
      queryClient.clear()
      void cleanUpDevice().finally(() => navigate(LOGIN_PATH, { replace: true }))
    })

    let lastCheck = 0
    const onResume = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastCheck < RESUME_THROTTLE_MS) return
      lastCheck = now
      void revalidate()
    }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)

    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [navigate, queryClient, revalidate])
}
