import type { AnchorHTMLAttributes } from 'react'
import { RollText } from '@/shared/motion/RollText'
import styles from './Button.module.css'
import type { ButtonVariant } from './Button'
import { cx } from './cx'

/**
 * A link that looks like a G3 pill button (a manage link, a calendar or map link, a phone call).
 * Same motion as Button: E16 press on touch, E2 roll of a plain-text label with a mouse.
 */
export function ButtonLink({
  className,
  variant = 'secondary',
  block = false,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; block?: boolean }) {
  return (
    <a
      className={cx(styles.button, styles[variant], block && styles.block, 'pressable', className)}
      {...props}
    >
      {typeof children === 'string' ? <RollText>{children}</RollText> : children}
    </a>
  )
}
