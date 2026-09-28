import type { ReactNode } from 'react'
import styles from './Card.module.css'
import { cx } from './cx'

/** A cream surface card (--radius-card, which a business theme may change). */
export function Card({
  children,
  as: Tag = 'div',
  className,
}: {
  children: ReactNode
  as?: 'div' | 'section' | 'article' | 'li'
  className?: string
}) {
  return <Tag className={cx(styles.card, className)}>{children}</Tag>
}
