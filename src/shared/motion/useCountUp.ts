import { useEffect, useState } from 'react'
import { useReducedMotion } from './useReducedMotion'

export interface CountUpOptions {
  /** False → the final value, no animation (E6 runs only on the first load of the day). */
  readonly enabled?: boolean
  /** False → 0 while waiting (e.g. `inView`); the count starts when it turns true. */
  readonly start?: boolean
  /** 1100–1400 ms in MOTION.md; default 1200. */
  readonly durationMs?: number
}

const easeOutCubic = (progress: number): number => 1 - (1 - progress) ** 3

/**
 * E6: counts an integer (a count, or cents to format with money.ts) from 0 up to `target`, once.
 * Reduced motion or `enabled: false` → `target` immediately. After the count, later changes of
 * `target` (a refetch) show the new value directly, without counting again.
 */
export function useCountUp(
  target: number,
  { enabled = true, start = true, durationMs = 1200 }: CountUpOptions = {},
): number {
  const reduced = useReducedMotion()
  const animate = enabled && !reduced
  const [frame, setFrame] = useState({ value: 0, done: false })
  const running = animate && start && !frame.done

  useEffect(() => {
    if (!running) return
    let handle = 0
    let origin: number | null = null
    const tick = (now: number) => {
      origin ??= now
      const progress = durationMs > 0 ? Math.min(1, (now - origin) / durationMs) : 1
      setFrame({ value: Math.round(target * easeOutCubic(progress)), done: progress >= 1 })
      if (progress < 1) handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [running, target, durationMs])

  if (!animate || frame.done) return target
  return start ? frame.value : 0
}
