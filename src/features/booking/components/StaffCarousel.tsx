import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useReducedMotion } from '@/shared/motion/useReducedMotion'
import { cx } from '@/shared/ui/cx'
import styles from './StaffCarousel.module.css'

/**
 * E12, only with more than four staff members: cards on a scroll-snap row (natural swipe), two
 * round 48px arrows and dots. Arrows scroll one card (500ms feel via smooth scrolling; instant with
 * reduced motion). The active dot follows an IntersectionObserver, not a scroll listener.
 */
export function StaffCarousel({ items }: { items: { id: string; node: ReactNode }[] }) {
  const { t } = useTranslation('booking')
  const reduced = useReducedMotion()
  const track = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const root = track.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index))
        }
      },
      { root, threshold: 0.6 },
    )
    for (const child of Array.from(root.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [items.length])

  const go = (index: number) => {
    const target = track.current?.children[Math.max(0, Math.min(items.length - 1, index))]
    target?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'start',
    })
  }

  return (
    <div className={styles.carousel}>
      <ul ref={track} className={styles.track}>
        {items.map((item, index) => (
          <li key={item.id} className={styles.card} data-index={index}>
            {item.node}
          </li>
        ))}
      </ul>
      <div className={styles.controls}>
        <button
          type="button"
          className={cx(styles.arrow, 'pressable')}
          aria-label={t('staff.previous')}
          disabled={active === 0}
          onClick={() => go(active - 1)}
        >
          <span className={cx(styles.chevron, styles.left)} aria-hidden="true" />
        </button>
        <span
          className={styles.dots}
          role="img"
          aria-label={t('staff.page', { current: active + 1, total: items.length })}
        >
          {items.map((item, index) => (
            <span
              key={item.id}
              className={styles.dot}
              data-active={index === active}
              aria-hidden="true"
            />
          ))}
        </span>
        <button
          type="button"
          className={cx(styles.arrow, 'pressable')}
          aria-label={t('staff.next')}
          disabled={active >= items.length - 1}
          onClick={() => go(active + 1)}
        >
          <span className={styles.chevron} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
