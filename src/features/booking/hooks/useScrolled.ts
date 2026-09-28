import { useCallback, useEffect, useState } from 'react'

/**
 * E13: true once the page has scrolled past a sentinel placed `threshold` px from the top.
 * An IntersectionObserver, not a scroll listener: nothing runs while scrolling.
 */
export function useScrolled() {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setScrolled(!entry.isIntersecting && entry.boundingClientRect.top < 0)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  const sentinel = useCallback((element: HTMLElement | null) => setNode(element), [])
  return { sentinel, scrolled } as const
}
