import type { ReactNode } from 'react'
import { useInView } from '@/shared/motion/useInView'
import styles from './Framed.module.css'
import { cx } from './cx'

/**
 * G5 + E8: a thin bronze frame, offset 10px right/down behind its child, sliding into place
 * when in view. The child carries the background (a Card, a cover): the frame is painted under
 * it. Space for the offset is reserved, so nothing shifts or overflows.
 */
export function Framed({
  children,
  as: Tag = 'div',
  className,
}: {
  children: ReactNode
  as?: 'div' | 'section' | 'article'
  className?: string
}) {
  const { ref, inView } = useInView<HTMLElement>()
  return (
    <Tag ref={ref} className={cx('framed', styles.framed, className)} data-inview={inView}>
      {children}
    </Tag>
  )
}
