import { useEffect, useRef } from 'react'

/**
 * The phone's back button (Android, in-app browsers) goes one booking step back instead of
 * leaving the page. While `active`, one history entry is kept armed; a popstate uses it up and
 * calls `onBack`, and the entry is armed again while still inside the flow. When the flow is back
 * at its first step, the armed entry is consumed, so the next back leaves the page as usual.
 * The URL never changes (the steps are not routes).
 */
export function useHardwareBack(active: boolean, onBack: () => void): void {
  const armed = useRef(false)
  const consuming = useRef(false)
  const latestOnBack = useRef(onBack)

  useEffect(() => {
    latestOnBack.current = onBack
  }, [onBack])

  useEffect(() => {
    const onPopState = () => {
      if (consuming.current) {
        consuming.current = false
        return
      }
      if (!armed.current) return
      armed.current = false
      latestOnBack.current()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (active && !armed.current) {
      window.history.pushState({ anakloStep: true }, '')
      armed.current = true
    } else if (!active && armed.current) {
      armed.current = false
      consuming.current = true
      window.history.back()
    }
  })
}
