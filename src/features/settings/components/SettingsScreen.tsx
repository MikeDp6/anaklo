import type { ReactNode } from 'react'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { SettingsHeader } from '@/features/staff/components/SettingsHeader'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useSettingsFrame, type SettingsFrame } from '../hooks/useSettingsFrame'
import styles from './screens.module.css'

/**
 * Frame of a schedule settings sub-page (contract 1.6 §4.1): the back link «Ρυθμίσεις», the G2
 * title, an intro, then the content once the business and its staff loaded (E17 skeleton until
 * then; a failed first load shows the reason and «Δοκίμασε ξανά»).
 */
export function SettingsScreen({
  title,
  intro,
  loadingLabel,
  children,
}: {
  title: string
  intro?: string
  /** For screen readers while the skeleton shows. */
  loadingLabel: string
  children: (frame: SettingsFrame) => ReactNode
}) {
  const state = useSettingsFrame()
  return (
    <Page busy={state.status === 'loading'}>
      <SettingsHeader title={title} />
      {intro && <p className={styles.intro}>{intro}</p>}
      {state.status === 'error' ? (
        <LoadError failure={state.failure} onRetry={state.retry} />
      ) : state.status === 'loading' ? (
        <ListSkeleton label={loadingLabel} />
      ) : (
        <>
          {state.refreshFailure && (
            <RefreshError failure={state.refreshFailure} onRetry={state.retry} />
          )}
          {children(state.frame)}
        </>
      )}
    </Page>
  )
}

/** E17 rows in place of a list (or a form) while it loads; the label is for screen readers. */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className={styles.list} role="status">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={72} shape="card" />
      ))}
    </div>
  )
}
