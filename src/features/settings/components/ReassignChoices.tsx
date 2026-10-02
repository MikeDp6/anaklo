import { useTranslation } from 'react-i18next'
import { NotifyToggle } from '@/features/appointments/components/NotifyToggle'
import { rpcFailureMessageKey, failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import type { ConflictResolution } from '../hooks/useConflictResolution'
import styles from './ConflictResolver.module.css'

/**
 * «Ανάθεση σε συνάδελφο» of a conflict row (contract 1.6 §4.9): one button per FREE active
 * colleague at the same time (`reassign_candidates`), «Ενημέρωση με SMS» off by default (D10);
 * nobody free → the sentence that says so, and only the cancellation remains.
 */
export function ReassignChoices({
  resolution,
  staffNames,
  time,
}: {
  resolution: ConflictResolution
  staffNames: ReadonlyMap<string, string>
  /** The appointment's start, business-local «10:40». */
  time: string
}) {
  const { t } = useTranslation(['pro', 'common'])
  const { candidates } = resolution
  const free = (candidates.data ?? []).filter((candidate) => candidate.free)

  return (
    <fieldset className={styles.group} disabled={resolution.busy}>
      <legend className={styles.legend}>{t('conflicts.reassignTitle')}</legend>
      {resolution.colleagueGone && (
        <p role="alert" className={styles.error}>
          {t('conflicts.notFreeAnymore')}
        </p>
      )}
      {candidates.data === undefined && candidates.isError ? (
        <div className={styles.inline} role="alert">
          <p className={styles.muted}>
            {t(rpcFailureMessageKey(failureOf(candidates.error), 'read'))}
          </p>
          <Button variant="secondary" onClick={() => void candidates.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      ) : candidates.data === undefined ? (
        <div role="status">
          <span className="visually-hidden">{t('conflicts.candidatesLoading')}</span>
          <Skeleton height={48} shape="pill" />
        </div>
      ) : free.length === 0 ? (
        <p className={styles.muted}>{t('conflicts.noneFree', { time })}</p>
      ) : (
        <>
          {resolution.canNotify && (
            <NotifyToggle
              checked={resolution.reassignNotify}
              disabled={resolution.busy}
              onChange={resolution.setReassignNotify}
            />
          )}
          <div className={styles.choices}>
            {free.map((candidate) => {
              const name = staffNames.get(candidate.staffId) ?? ''
              return (
                <Button
                  key={candidate.staffId}
                  variant="secondary"
                  onClick={() => resolution.reassign(candidate.staffId)}
                >
                  {resolution.pendingStaffId === candidate.staffId
                    ? t('conflicts.reassigning')
                    : t('conflicts.reassign', { name })}
                </Button>
              )
            })}
          </div>
        </>
      )}
    </fieldset>
  )
}
