import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { formatTime, useAppLocale } from '@/features/calendar/format'
import { useNow } from '@/features/calendar/hooks/useNow'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { absenceWindow } from '../absenceWindow'
import { absenceConflictsQuery, useMarkAbsence } from '../hooks/useMarkAbsence'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import type { AbsenceResult } from '../schema'
import { ConflictList } from './ConflictList'
import styles from './screens.module.css'

/**
 * Flow 6 of SPEC §5 (contract 1.6 §4.10): who is out → «Καταχώρηση απουσίας» (a `leave` time off
 * from now to the end of the business's day, never a reason) → their appointments of that window,
 * each reassigned to a free colleague or cancelled with SMS → «Όλα τα ραντεβού τακτοποιήθηκαν».
 * Nothing is listed before `mark_absence` answered; running it again writes nothing new.
 */
export function AbsenceFlow({
  frame,
  serviceNames,
}: {
  frame: SettingsFrame
  serviceNames: ReadonlyMap<string, string>
}) {
  const { t } = useTranslation('pro')
  const locale = useAppLocale()
  const navigate = useNavigate()
  const zone = frame.business.timeZone
  const now = useNow(30_000)
  const [staffId, setStaffId] = useState('')
  const mark = useMarkAbsence(frame.businessId)
  const busy = mark.pending || mark.locked

  if (mark.result && mark.variables) {
    const finish = (
      <Button block onClick={() => void navigate('/')}>
        {t('absence.done')}
      </Button>
    )
    return (
      <>
        <p role="status" className={styles.status}>
          {t(absenceNoteKey(mark.result))}
        </p>
        <h2 className={styles.legend}>{t('absence.appointments')}</h2>
        <ConflictList
          businessId={frame.businessId}
          timeZone={zone}
          query={absenceConflictsQuery(mark.variables)}
          staffNames={frame.staffNames}
          serviceNames={serviceNames}
          empty={
            <div className={styles.done}>
              <p className={styles.muted}>{t('absence.none')}</p>
              {finish}
            </div>
          }
          done={
            <div className={styles.done}>
              <p role="status" className={styles.status}>
                {t('absence.allResolved')}
              </p>
              {finish}
            </div>
          }
        />
      </>
    )
  }

  if (frame.activeStaff.length === 0) return <p className={styles.muted}>{t('absence.noStaff')}</p>
  const options = [
    { value: '', label: t('absence.choose') },
    ...frame.activeStaff.map((member) => ({ value: member.id, label: member.displayName })),
  ]
  return (
    <div className={styles.stack}>
      <SelectField
        label={t('absence.staff')}
        options={options}
        value={staffId}
        disabled={busy}
        onChange={(event) => setStaffId(event.currentTarget.value)}
      />
      <p className={styles.muted}>
        {t('absence.window', { time: formatTime(absenceWindow(now, zone).from, zone, locale) })}
      </p>
      <SaveFailure
        failure={mark.failure}
        locked={mark.locked}
        pending={mark.pending}
        onRetry={mark.retry}
        onClose={mark.reset}
      />
      {!mark.locked && (
        <Button
          block
          disabled={staffId === '' || mark.pending}
          onClick={() => mark.submit({ staffId, ...absenceWindow(new Date(), zone) })}
        >
          {mark.pending ? t('absence.submitting') : t('absence.submit')}
        </Button>
      )}
    </div>
  )
}

function absenceNoteKey(
  result: AbsenceResult,
): 'absence.created' | 'absence.extended' | 'absence.covered' {
  if (result.created) return 'absence.created'
  return result.extended ? 'absence.extended' : 'absence.covered'
}
