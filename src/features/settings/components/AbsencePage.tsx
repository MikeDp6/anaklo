import { useTranslation } from 'react-i18next'
import { useServiceNames } from '../hooks/useServiceNames'
import type { SettingsFrame } from '../hooks/useSettingsFrame'
import { AbsenceFlow } from './AbsenceFlow'
import { SettingsScreen } from './SettingsScreen'

/** /settings/absence (owner, manager; contract 1.6 §4.10): «Έκτακτη απουσία». */
export function AbsencePage() {
  const { t } = useTranslation('pro')
  return (
    <SettingsScreen
      title={t('absence.title')}
      intro={t('absence.intro')}
      loadingLabel={t('absence.loading')}
    >
      {(frame) => <Absence frame={frame} />}
    </SettingsScreen>
  )
}

function Absence({ frame }: { frame: SettingsFrame }) {
  const serviceNames = useServiceNames(frame.businessId)
  return <AbsenceFlow frame={frame} serviceNames={serviceNames} />
}
