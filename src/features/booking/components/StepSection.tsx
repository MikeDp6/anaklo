import { useEffect, useRef, type ReactNode } from 'react'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { cx } from '@/shared/ui/cx'
import type { Direction } from '../flow/bookingReducer'
import styles from './steps.module.css'

/**
 * One booking step: G1 label (E3) over a G2 title, entering with E14 (from the right; from the
 * left when going back). The section takes focus when it replaces another step, so a screen
 * reader starts at its title. Motion never blocks: the content is interactive from the start.
 */
export function StepSection({
  direction,
  eyebrow,
  title,
  children,
  takeFocus = true,
}: {
  direction: Direction
  eyebrow: string
  title: string
  children: ReactNode
  /** False when a field of the step takes the focus itself (the OTP code). */
  takeFocus?: boolean
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (takeFocus && direction !== 'none') ref.current?.focus({ preventScroll: true })
  }, [direction, takeFocus])

  const enter =
    direction === 'forward' ? 'step-enter' : direction === 'back' ? 'step-enter-back' : null
  return (
    <section ref={ref} tabIndex={-1} aria-label={title} className={cx(styles.step, enter)}>
      <div className={styles.heading}>
        <Eyebrow reveal>{eyebrow}</Eyebrow>
        <DisplayTitle as="h2" size="md">
          {title}
        </DisplayTitle>
      </div>
      {children}
    </section>
  )
}
