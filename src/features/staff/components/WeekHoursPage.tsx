import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { useMember } from '@/features/auth/hooks/useMember'
import chips from '@/features/calendar/components/StaffChips.module.css'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { cx } from '@/shared/ui/cx'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { useStaff } from '../hooks/useStaff'
import { useWeekHours } from '../hooks/useWeekHours'
import type { StaffMember } from '../schema'
import { SettingsHeader } from './SettingsHeader'
import styles from './settings.module.css'
import { WeekHoursEditor } from './WeekHoursEditor'

/**
 * /settings/hours?staff=<id> (owner, manager; contract 1.6 §4.5): the staff chips, then the week
 * of the chosen one (default: the first active). One primary action, «Αποθήκευση», in the editor.
 */
export function WeekHoursPage() {
  const { t } = useTranslation('pro')
  const businessId = useMember().membership.businessId
  const staff = useStaff(businessId)
  const [params, setParams] = useSearchParams()
  const chosen = chooseStaff(staff.data ?? [], params.get('staff'))
  const hours = useWeekHours(businessId, chosen?.id ?? null)
  const loading = staff.data === undefined || (chosen !== null && hours.data === undefined)
  const failed = [staff, hours].find(failedWithoutData)
  const refreshFailed = [staff, hours].find(failedRefresh)
  const retry = () => {
    void staff.refetch()
    if (chosen) void hours.refetch()
  }

  return (
    <Page busy={loading && !failed}>
      <SettingsHeader title={t('hours.title')} />
      {staff.data && staff.data.length > 0 && (
        <div className={chips.chips} role="group" aria-label={t('hours.staffLabel')}>
          {staff.data.map((member) => (
            <button
              key={member.id}
              type="button"
              className={cx(chips.chip, 'pressable')}
              aria-pressed={member.id === chosen?.id}
              onClick={() => setParams({ staff: member.id }, { replace: true })}
            >
              <span
                className={chips.dot}
                style={{ '--staff-color': member.color ?? undefined }}
                aria-hidden="true"
              />
              {member.displayName}
            </button>
          ))}
        </div>
      )}
      {failed ? (
        <LoadError failure={failureOf(failed.error)} onRetry={retry} />
      ) : staff.data && !chosen ? (
        <p className={styles.muted}>{t('hours.noStaff')}</p>
      ) : loading || !chosen || !hours.data ? (
        <WeekHoursSkeleton />
      ) : (
        <>
          {refreshFailed && (
            <RefreshError failure={failureOf(refreshFailed.error)} onRetry={retry} />
          )}
          <WeekHoursEditor
            key={chosen.id}
            businessId={businessId}
            staffId={chosen.id}
            rows={hours.data}
          />
        </>
      )}
    </Page>
  )
}

/** The `?staff=` member if known, else the first active one (or the first at all). */
function chooseStaff(staff: readonly StaffMember[], requested: string | null): StaffMember | null {
  return (
    staff.find((member) => member.id === requested) ??
    staff.find((member) => member.active) ??
    staff[0] ??
    null
  )
}

/** E17: seven day rows while the week loads. */
function WeekHoursSkeleton() {
  const { t } = useTranslation('pro')
  return (
    <div className={styles.stack} role="status">
      <span className="visually-hidden">{t('hours.loading')}</span>
      {Array.from({ length: 7 }, (_, day) => (
        <Skeleton key={day} height={96} />
      ))}
    </div>
  )
}
