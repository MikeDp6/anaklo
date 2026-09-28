import type { ReactNode } from 'react'
import styles from './Page.module.css'

/** The main column of every screen: mobile-first, one hand, ≤ --page-max wide. */
export function Page({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <main className={styles.page} aria-busy={busy}>
      {children}
    </main>
  )
}
