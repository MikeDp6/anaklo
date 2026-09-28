import type { ButtonHTMLAttributes, Ref } from 'react'
import { RollText } from '@/shared/motion/RollText'
import styles from './Button.module.css'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'glass'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * G3 pill. `primary`: brand fill (espresso/cream by default, the business colour when themed).
   * `secondary`: cream with a border. `glass`: on dark surfaces only (G6 hero, dark cards).
   */
  variant?: ButtonVariant
  /** E1 liquid fill on hover (mouse only). Only the main CTA of a booking-page screen. */
  liquid?: boolean
  /** Full width: the one main action of a mobile screen. */
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

/**
 * Every button: ≥ 44px, 16px text, E16 press on touch, E2 roll of a plain-text label with a mouse.
 * Motion never delays the action: the click fires at once, the button is never disabled by an
 * animation.
 */
export function Button({
  className,
  type = 'button',
  variant = 'primary',
  liquid = false,
  block = false,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        styles.button,
        styles[variant],
        block && styles.block,
        'pressable',
        liquid && 'btn-fill',
        className,
      )}
      {...props}
    >
      {typeof children === 'string' ? <RollText>{children}</RollText> : children}
    </button>
  )
}
