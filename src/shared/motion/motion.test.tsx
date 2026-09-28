import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RollText } from './RollText'
import { SplitWords } from './SplitWords'
import { useCountUp } from './useCountUp'
import { useInView } from './useInView'
import { useReducedMotion } from './useReducedMotion'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A controllable `prefers-reduced-motion` media query. */
function mockReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>()
  const list = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list as unknown as MediaQueryList),
  )
  return {
    set(matches: boolean) {
      list.matches = matches
      for (const listener of listeners) listener()
    },
  }
}

/** requestAnimationFrame driven by hand: `frame(ms)` runs the queued callbacks at time `ms`. */
function mockAnimationFrames() {
  let queue: FrameRequestCallback[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => queue.push(callback)),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return {
    frame(time: number) {
      const due = queue
      queue = []
      act(() => {
        for (const callback of due) callback(time)
      })
    },
    pending: () => queue.length,
  }
}

/** An IntersectionObserver whose entries the test fires. */
function mockIntersectionObserver() {
  const observers: { callback: IntersectionObserverCallback; disconnect: () => void }[] = []
  class FakeObserver {
    readonly disconnect = vi.fn()
    constructor(readonly callback: IntersectionObserverCallback) {
      observers.push(this)
    }
    observe() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  return {
    observers,
    enter() {
      act(() => {
        for (const { callback } of observers) {
          const entry = { isIntersecting: true } as IntersectionObserverEntry
          callback([entry], {} as IntersectionObserver)
        }
      })
    },
  }
}

describe('useReducedMotion', () => {
  it('follows the media query, including live changes', () => {
    const media = mockReducedMotion(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
    act(() => media.set(true))
    expect(result.current).toBe(true)
  })

  it('assumes reduced motion when matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)
  })
})

describe('useCountUp (E6)', () => {
  it('with reduced motion returns the final value at once and never animates', () => {
    mockReducedMotion(true)
    const frames = mockAnimationFrames()
    const { result } = renderHook(() => useCountUp(4500))
    expect(result.current).toBe(4500)
    expect(frames.pending()).toBe(0)
  })

  it('when disabled (not the first load of the day) returns the final value at once', () => {
    mockReducedMotion(false)
    const frames = mockAnimationFrames()
    const { result } = renderHook(() => useCountUp(12, { enabled: false }))
    expect(result.current).toBe(12)
    expect(frames.pending()).toBe(0)
  })

  it('counts from 0 with ease-out and ends exactly on the target, once', () => {
    mockReducedMotion(false)
    const frames = mockAnimationFrames()
    const { result, rerender } = renderHook(
      ({ target }) => useCountUp(target, { durationMs: 1000 }),
      {
        initialProps: { target: 1000 },
      },
    )
    expect(result.current).toBe(0)
    frames.frame(0)
    frames.frame(500)
    expect(result.current).toBe(875) // 1 - (1 - 0.5)³
    frames.frame(1000)
    expect(result.current).toBe(1000)
    expect(frames.pending()).toBe(0)

    rerender({ target: 1200 }) // a refetch: new value directly, no second count
    expect(result.current).toBe(1200)
    expect(frames.pending()).toBe(0)
  })

  it('waits at 0 until start turns true', () => {
    mockReducedMotion(false)
    const frames = mockAnimationFrames()
    const { result, rerender } = renderHook(({ start }) => useCountUp(10, { start }), {
      initialProps: { start: false },
    })
    expect(result.current).toBe(0)
    expect(frames.pending()).toBe(0)
    rerender({ start: true })
    expect(frames.pending()).toBe(1)
  })
})

describe('useInView', () => {
  function Probe() {
    const { ref, inView } = useInView<HTMLDivElement>()
    return <div ref={ref} data-testid="probe" data-inview={inView} />
  }

  it('is in view at once without IntersectionObserver', () => {
    mockReducedMotion(false)
    vi.stubGlobal('IntersectionObserver', undefined)
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveAttribute('data-inview', 'true')
  })

  it('is in view at once with reduced motion, without observing', () => {
    mockReducedMotion(true)
    const io = mockIntersectionObserver()
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveAttribute('data-inview', 'true')
    expect(io.observers).toHaveLength(0)
  })

  it('turns true when the element enters the viewport, then stops observing', () => {
    mockReducedMotion(false)
    const io = mockIntersectionObserver()
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveAttribute('data-inview', 'false')
    io.enter()
    expect(screen.getByTestId('probe')).toHaveAttribute('data-inview', 'true')
    expect(io.observers[0]?.disconnect).toHaveBeenCalled()
  })
})

describe('SplitWords (E5)', () => {
  it('a heading is read as the whole title; the words are aria-hidden', () => {
    mockReducedMotion(false)
    render(<SplitWords as="h1" text="Καλημέρα, Νίκο" />)
    const heading = screen.getByRole('heading', { level: 1, name: 'Καλημέρα, Νίκο' })
    expect(heading).toHaveAttribute('aria-label', 'Καλημέρα, Νίκο')
    const words = heading.querySelectorAll('.split-word')
    expect([...words].map((word) => word.textContent)).toEqual(['Καλημέρα,', 'Νίκο'])
    for (const word of words) expect(word).toHaveAttribute('aria-hidden', 'true')
    expect(heading).toHaveTextContent('Καλημέρα, Νίκο') // spaces stay between the words
  })

  it('a plain span keeps the text in a visually hidden copy (no aria-label on a span)', () => {
    mockReducedMotion(false)
    const { container } = render(<SplitWords text="Demo Barber" />)
    const span = container.firstElementChild
    expect(span).not.toHaveAttribute('aria-label')
    expect(span?.querySelector('.visually-hidden')).toHaveTextContent('Demo Barber')
  })

  it('with reduced motion is in its final state at once', () => {
    mockReducedMotion(true)
    render(<SplitWords as="h2" text="Demo Barber" />)
    expect(screen.getByRole('heading', { name: 'Demo Barber' })).toHaveAttribute(
      'data-inview',
      'true',
    )
  })
})

describe('RollText (E2)', () => {
  it('is announced once: the rolling copy is aria-hidden', () => {
    render(
      <button type="button">
        <RollText>Κλείσε ραντεβού</RollText>
      </button>,
    )
    const button = screen.getByRole('button', { name: 'Κλείσε ραντεβού' })
    expect(button.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
  })
})

describe('motion.css', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'shared', 'motion', 'motion.css'), 'utf8')
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

  it('has the mandatory reduced-motion block: no animation, content at its final place', () => {
    expect(reduced).toContain('animation: none !important')
    expect(reduced).toContain('transition: none !important')
    expect(reduced).toMatch(/\.reveal,\s*\.split-word\s*\{\s*opacity: 1 !important;/)
  })

  it('shows hover effects only with a mouse', () => {
    for (const hover of css.match(/[^\n]*:hover[^\n]*/g) ?? []) {
      const before = css.slice(0, css.indexOf(hover))
      const lastMedia = before.lastIndexOf('@media (hover: hover) and (pointer: fine)')
      expect(lastMedia, hover).toBeGreaterThan(before.lastIndexOf('\n}\n'))
    }
  })
})
