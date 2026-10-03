import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/Button'
import type { LiveClientCard } from '../schema'
import { ClientAppointments } from './ClientAppointments'
import { ClientConsents } from './ClientConsents'
import { ClientEditSheet } from './ClientEditSheet'
import { ClientHeader } from './ClientHeader'
import { ClientNotes } from './ClientNotes'
import { ClientRhythm } from './ClientRhythm'
import styles from './clients.module.css'
import { EraseDialog } from './EraseDialog'

/**
 * A live client's card (contract 1.8 §4.3), in this order: who, the rhythm with the counters and
 * the primary action, the appointments, the notes, the consents, and (owner only, decided by the
 * server: `can.erase`) «Ανωνυμοποίηση πελάτη». Staff see the same card; the server nulls the
 * amounts of their colleagues' appointments.
 */
export function ClientCardView({
  businessId,
  userId,
  card,
}: {
  businessId: string
  userId: string
  card: LiveClientCard
}) {
  const { t } = useTranslation('pro')
  const [open, setOpen] = useState<'edit' | 'erase' | null>(null)
  const edit = () => setOpen('edit')
  return (
    <>
      <ClientHeader card={card} onEdit={edit} />
      <ClientRhythm card={card} onEdit={edit} />
      <ClientAppointments card={card} />
      <ClientNotes businessId={businessId} authorId={userId} card={card} />
      <ClientConsents businessId={businessId} card={card} />
      {card.can.erase && (
        <Button variant="secondary" className={styles.danger} onClick={() => setOpen('erase')}>
          {t('clients.erase.open')}
        </Button>
      )}
      {open === 'edit' && (
        <ClientEditSheet businessId={businessId} card={card} onClose={() => setOpen(null)} />
      )}
      {open === 'erase' && (
        <EraseDialog
          businessId={businessId}
          clientId={card.clientId}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
