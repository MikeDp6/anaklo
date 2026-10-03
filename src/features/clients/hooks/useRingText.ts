import { useTranslation } from 'react-i18next'
import type { ClientRing } from '../schema'

export interface RingText {
  /** The state sentence («Μέσα στο συνηθισμένο διάστημα (περίπου 4 εβδομάδες).»). */
  readonly sentence: string
  /** Where the interval comes from («με βάση τον κλάδο»), when there is one. */
  readonly basis: string | null
  /** The ring's accessible name: days since the last visit, the sentence and its basis. */
  readonly full: string
}

/** The texts of the E18 ring (contract 1.8 §4.4), from the server's values only. */
export function useRingText(ring: ClientRing): RingText {
  const { t } = useTranslation('pro')
  const sentence =
    ring.state === 'within'
      ? t('clients.ring.within', { count: ring.intervalWeeks ?? 0 })
      : ring.state === 'beyond'
        ? t('clients.ring.beyond', { count: ring.overdueDays ?? 0 })
        : ring.state === 'no_visits'
          ? t('clients.ring.noVisits')
          : t('clients.ring.noInterval')
  const basis =
    ring.state === 'within' || ring.state === 'beyond'
      ? ring.hintKey === 'nextVisit.business'
        ? t('clients.ring.basisBusiness')
        : ring.hintKey === 'nextVisit.vertical'
          ? t('clients.ring.basisVertical')
          : null
      : null
  const since =
    ring.daysSinceLast === null ? null : t('clients.ring.sinceLast', { count: ring.daysSinceLast })
  return {
    sentence,
    basis,
    full: [since, sentence, basis].filter(Boolean).join(' '),
  }
}
