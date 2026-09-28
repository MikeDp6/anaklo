import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function media(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null
}

function subscribe(onChange: () => void): () => void {
  const list = media()
  if (!list) return () => {}
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

/** Without matchMedia (very old browsers, tests) we assume "reduce": no motion is the safe side. */
function snapshot(): boolean {
  return media()?.matches ?? true
}

const serverSnapshot = (): boolean => true

/** True when the visitor asked for less motion (MOTION.md §0.2); follows live changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
