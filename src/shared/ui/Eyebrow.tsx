import type { ReactNode } from 'react'
import { useInView } from '@/shared/motion/useInView'
import styles from './Eyebrow.module.css'
import { cx } from './cx'

/**
 * G1: the widely spaced capital label above a title («ΕΠΟΜΕΝΟ · ΣΕ 25′»). Bronze on light,
 * gold with `onDark` (gold never on light). `reveal` adds E3 (fade + 10px rise when in view).
 * Text from i18n; CSS does the capitals (`lang="el"` drops the accents).
 */
export function Eyebrow({
  children,
  as: Tag = 'p',
  onDark = false,
  reveal = false,
  className,
}: {
  children: ReactNode
  as?: 'p' | 'span'
  onDark?: boolean
  reveal?: boolean
  className?: string
}) {
  const { ref, inView } = useInView<HTMLElement>()
  return (
    <Tag
      ref={reveal ? ref : undefined}
      data-inview={reveal ? inView : undefined}
      className={cx(
        styles.eyebrow,
        onDark && styles.onDark,
        reveal && 'reveal reveal--eyebrow',
        className,
      )}
    >
      {children}
    </Tag>
  )
}
