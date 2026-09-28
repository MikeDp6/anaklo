import { useCallback, useEffect, useState } from 'react'
import { useReducedMotion } from './useReducedMotion'

export interface InViewOptions {
  /** Default: trigger when the element is 10% above the bottom of the viewport. */
  readonly rootMargin?: string
  readonly threshold?: number
}

/**
 * Turns true once, the first time the element enters the viewport (E3/E4/E5/E8), and stays true.
 * True immediately with reduced motion or without IntersectionObserver, so content never waits
 * for an observer to show up.
 *
 * Usage: `const { ref, inView } = useInView<HTMLDivElement>()` →
 * `<div ref={ref} className="reveal" data-inview={inView} />`.
 */
export function useInView<T extends Element>({
  rootMargin = '0px 0px -10% 0px',
  threshold = 0,
}: InViewOptions = {}) {
  const reduced = useReducedMotion()
  const supported = typeof IntersectionObserver !== 'undefined'
  const [node, setNode] = useState<T | null>(null)
  const [seen, setSeen] = useState(false)
  const inView = reduced || !supported || seen

  useEffect(() => {
    if (!node || inView) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      { rootMargin, threshold },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, inView, rootMargin, threshold])

  const ref = useCallback((element: T | null) => setNode(element), [])
  return { ref, inView } as const
}
