import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { ActiveSheet, type OpenSheet } from '@/features/appointments/components/ActiveSheet'
import { addLocalDays, toLocalDate, type LocalDate } from '@/shared/lib/dates'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import { defaultColumns, parseDateParam, toggleColumn } from '../columns'
import { useBusinessToday } from '../hooks/useBusinessToday'
import { useDayColumns } from '../hooks/useDayColumns'
import { useDayFrame } from '../hooks/useDayQueries'
import { useNow } from '../hooks/useNow'
import { useWorkspace, type Workspace } from '../hooks/useWorkspace'
import { failedRefresh } from '../queryState'
import { DayHeader } from './DayHeader'
import { DaySkeleton } from './DaySkeleton'
import { DayView } from './DayView'
import { LoadError } from './LoadError'
import { RefreshError } from './RefreshError'
import { StaffChips } from './StaffChips'

/** /app/day?date=yyyy-MM-dd: the day calendar with a column per chosen staff member. */
export function DayPage() {
  const { t } = useTranslation('pro')
  const state = useWorkspace()
  return (
    <Page busy={state.status === 'loading'}>
      {state.status === 'ready' ? (
        <DayContent workspace={state.workspace} />
      ) : (
        <>
          <DisplayTitle size="md">{t('day.title')}</DisplayTitle>
          {state.status === 'loading' ? (
            <DaySkeleton />
          ) : (
            <LoadError failure={state.failure} onRetry={state.retry} />
          )}
        </>
      )}
    </Page>
  )
}

function DayContent({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation('pro')
  const { business, businessId, membership } = workspace
  const today = useBusinessToday(business.timeZone)
  const [params, setParams] = useSearchParams()
  const date: LocalDate = parseDateParam(params.get('date')) ?? today
  const [selected, setSelected] = useState(() =>
    defaultColumns(
      workspace.activeStaff.map((member) => member.id),
      membership.staffId,
    ),
  )
  const [sheet, setSheet] = useState<OpenSheet | null>(null)
  const now = useNow()
  const frame = useDayFrame(businessId, date)
  const day = useDayColumns(workspace, date, selected, frame.data)
  const goTo = (next: LocalDate) =>
    setParams(next === today ? {} : { date: next }, { replace: true })
  // A failed poll keeps the grid (and the page-level sheet): only a first load failure replaces it.
  const refreshFailure = failedRefresh(frame) ? frame.error : day.refreshFailure
  const retry = () => {
    if (frame.isError) void frame.refetch()
    day.retry()
  }

  return (
    <>
      <DisplayTitle size="md">{t('day.title')}</DisplayTitle>
      <DayHeader
        date={date}
        isToday={date === today}
        onPrevious={() => goTo(addLocalDays(date, -1))}
        onNext={() => goTo(addLocalDays(date, 1))}
        onToday={() => goTo(today)}
      />
      <StaffChips
        staff={workspace.activeStaff}
        selected={selected}
        onToggle={(id) => setSelected((current) => toggleColumn(current, id))}
      />
      <Button
        onClick={() => setSheet({ kind: 'quickAdd', preset: { staffId: selected[0], date } })}
        block
      >
        {t('quickAdd.open')}
      </Button>
      {frame.data === undefined ? (
        frame.isError ? (
          <LoadError failure={failureOf(frame.error)} onRetry={() => void frame.refetch()} />
        ) : (
          <DaySkeleton />
        )
      ) : day.failure ? (
        <LoadError failure={failureOf(day.failure)} onRetry={day.retry} />
      ) : (
        <>
          {refreshFailure && <RefreshError failure={failureOf(refreshFailure)} onRetry={retry} />}
          <DayView
            workspace={workspace}
            frame={frame.data}
            columns={day.columns}
            now={now}
            isToday={date === today}
            onOpen={(appointment) =>
              setSheet({
                kind: 'appointment',
                target: {
                  appointmentId: appointment.id,
                  staffId: appointment.staffId,
                  localDate: toLocalDate(new Date(appointment.startsAt), business.timeZone),
                },
              })
            }
            onWalkIn={(staffId) => setSheet({ kind: 'walkIn', staffId })}
          />
        </>
      )}
      <ActiveSheet
        sheet={sheet}
        workspace={workspace}
        today={today}
        onClose={() => setSheet(null)}
      />
    </>
  )
}
