import { SplitWords } from '@/shared/motion/SplitWords'
import styles from './DisplayTitle.module.css'
import { cx } from './cx'

export type DisplayTitleSize = 'md' | 'lg' | 'xl'

/**
 * G2: a large Didot title (400, tight tracking). `animate` adds E5 (word by word when in view),
 * e.g. the business name on the booking page or the greeting in the app; the heading keeps the
 * whole text as its accessible name. `accent` = bronze on light / gold on dark.
 */
export function DisplayTitle({
  children,
  as = 'h1',
  size = 'lg',
  onDark = false,
  accent = false,
  animate = false,
  className,
}: {
  /** From i18n or data (a business name), never a literal. */
  children: string
  as?: 'h1' | 'h2' | 'h3'
  size?: DisplayTitleSize
  onDark?: boolean
  accent?: boolean
  animate?: boolean
  className?: string
}) {
  const classes = cx(
    styles.title,
    styles[size],
    onDark && styles.onDark,
    accent && styles.accent,
    className,
  )
  if (animate) return <SplitWords as={as} text={children} className={classes} />
  const Tag = as
  return <Tag className={classes}>{children}</Tag>
}
