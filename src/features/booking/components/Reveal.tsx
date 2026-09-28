import type { ReactNode } from 'react'
import { useInView } from '@/shared/motion/useInView'
import { cx } from '@/shared/ui/cx'

/**
 * E4 in the app: a block fades in and rises 16px when it enters the viewport (transform and
 * opacity only, so nothing around it moves). Reduced motion: visible at once, in place.
 */
export function Reveal({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'p' | 'ul'
}) {
  const { ref, inView } = useInView<HTMLElement>()
  return (
    <Tag ref={ref} data-inview={inView} className={cx('reveal', 'reveal--block', className)}>
      {children}
    </Tag>
  )
}
