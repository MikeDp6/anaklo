import type { ReactNode } from 'react'
import styles from './Notice.module.css'

/**
 * Empty and error states: a title, one sentence, and at most one action.
 * When the notice is the whole page (not found, failed to load), pass `headingLevel={1}` so the
 * page still has a top-level heading.
 */
export function Notice({
  title,
  body,
  action,
  tone = 'info',
  headingLevel = 2,
}: {
  title: string
  body: string
  action?: ReactNode
  tone?: 'info' | 'error'
  headingLevel?: 1 | 2
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  return (
    <section className={styles.notice} role={tone === 'error' ? 'alert' : undefined}>
      <Heading className={styles.title}>{title}</Heading>
      <p className={styles.body}>{body}</p>
      {action}
    </section>
  )
}
