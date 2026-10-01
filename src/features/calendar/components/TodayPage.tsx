import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActiveSheet, type OpenSheet } from '@/features/appointments/components/ActiveSheet'
import { WalkInButton } from '@/features/appointments/components/WalkInButton'
import { toLocalDate } from '@/shared/lib/dates'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Eyebrow } from '@/shared/ui/Eyebrow'
import { Page } from '@/shared/ui/Page'
import { formatLongDate, useAppLocale } from '../format'
import { useBusinessToday } from '../hooks/useBusinessToday'
import { useTodaySummary } from '../hooks/useDayQueries'
import { useNow } from '../hooks/useNow'
import { useWorkspace, type Workspace } from '../hooks/useWorkspace'
import { GapsList } from './GapsList'
import { LoadError } from './LoadError'
import { NextList } from './NextList'
import { RefreshError } from './RefreshError'
import styles from './Today.module.css'
import { TodaySkeleton } from './TodaySkeleton'
import { TodayStats } from './TodayStats'
import { ToMarkCard } from './ToMarkCard'

/** /app: «Σήμερα» — next, numbers, to mark, gaps, walk-in (phase 1 §1.4). */
export function TodayPage() {
  const { t } = useTranslation('pro')
  const state = useWorkspace()
  return (
    <Page busy={state.status === 'loading'}>
      {state.status === 'ready' ? (
        <TodayContent workspace={state.workspace} />
      ) : (
        <>
          <DisplayTitle size="md">{t('today.title')}</DisplayTitle>
          {state.status === 'loading' ? (
            <TodaySkeleton />
          ) : (
            <LoadError failure={state.failure} onRetry={state.retry} />
          )}
        </>
      )}
    </Page>
  )
}

function TodayContent({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const { business, businessId } = workspace
  const today = useBusinessToday(business.timeZone)
  const summary = useTodaySummary(businessId, today)
  const now = useNow()
  const [sheet, setSheet] = useState<OpenSheet | null>(null)
  const data = summary.data
  const showStaff = data?.scope === 'business'

  return (
    <>
      <header className={styles.header}>
        <Eyebrow>{formatLongDate(today, locale)}</Eyebrow>
        <DisplayTitle size="md">{t('today.title')}</DisplayTitle>
      </header>
      <Button onClick={() => setSheet({ kind: 'quickAdd' })} block>
        {t('quickAdd.open')}
      </Button>
      {data === undefined ? (
        summary.isError ? (
          <LoadError failure={failureOf(summary.error)} onRetry={() => void summary.refetch()} />
        ) : (
          <TodaySkeleton />
        )
      ) : (
        <>
          {/* A failed poll keeps the numbers and the lists (and the rows' locked retries). */}
          {summary.isError && (
            <RefreshError
              failure={failureOf(summary.error)}
              onRetry={() => void summary.refetch()}
            />
          )}
          <TodayStats key={data.localDate} businessId={businessId} summary={data} />
          <ToMarkCard
            workspace={workspace}
            count={data.counts.toMark}
            items={data.toMark}
            today={today}
          />
          <NextList
            workspace={workspace}
            items={data.next}
            showStaff={showStaff}
            now={now}
            onOpen={(item) =>
              setSheet({
                kind: 'appointment',
                target: {
                  appointmentId: item.appointmentId,
                  staffId: item.staffId,
                  localDate: toLocalDate(new Date(item.startsAt), business.timeZone),
                },
              })
            }
          />
          <GapsList
            workspace={workspace}
            gaps={data.gaps}
            showStaff={showStaff}
            onBook={(gap) =>
              setSheet({
                kind: 'quickAdd',
                preset: { staffId: gap.staffId, startsAt: gap.startsAt },
              })
            }
          />
        </>
      )}
      <section className={styles.section} aria-labelledby="today-walk-in">
        <h2 id="today-walk-in" className={styles.sectionTitle}>
          {t('today.walkIn')}
        </h2>
        <p className={styles.muted}>{t('today.walkInHint')}</p>
        <div className={styles.walkIns}>
          {workspace.activeStaff.map((member) => (
            <WalkInButton
              key={member.id}
              staff={member}
              onOpen={(staffId) => setSheet({ kind: 'walkIn', staffId })}
            />
          ))}
        </div>
      </section>
      <ActiveSheet
        sheet={sheet}
        workspace={workspace}
        today={today}
        onClose={() => setSheet(null)}
      />
    </>
  )
}
