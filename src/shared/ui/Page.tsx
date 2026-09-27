import type { ReactNode } from 'react'
import styles from './Page.module.css'

export function Page({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <main className={styles.page} aria-busy={busy}>
      {children}
    </main>
  )
}
