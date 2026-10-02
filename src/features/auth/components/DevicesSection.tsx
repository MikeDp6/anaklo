import { useTranslation } from 'react-i18next'
import { SaveFailure } from '@/features/appointments/components/SaveFailure'
import { LoadError } from '@/features/calendar/components/LoadError'
import { ListSkeleton } from '@/features/settings/components/SettingsScreen'
import { failedWithoutData } from '@/features/calendar/queryState'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import type { SecurityPageState } from '../hooks/useSecurityPage'
import type { VerifiedFactor } from '../mfaApi'
import styles from './mfa.module.css'

/**
 * «Συσκευές κωδικών» (contract 1.7 §6.7): with one device, the banner and «Προσθήκη συσκευής» on
 * top, and that device's «Αφαίρεση» disabled with the reason; with more, each can be removed
 * after one confirmation (the server then asks for a fresh code). Results only after the answer.
 */
export function DevicesSection({ page }: { page: SecurityPageState }) {
  const { t } = useTranslation('pro')
  const { remove } = page
  return (
    <section className={styles.section} aria-labelledby="security-devices">
      <h2 id="security-devices" className={styles.sectionTitle}>
        {t('security.devices')}
      </h2>
      {page.single && (
        <div className={styles.banner} role="note">
          <p>{t('security.singleBanner')}</p>
          <Button block onClick={page.addDevice}>
            {t('security.add')}
          </Button>
        </div>
      )}
      {remove.succeeded && (
        <p role="status" className={styles.status}>
          {t('security.removed')}
        </p>
      )}
      <SaveFailure
        failure={remove.failure}
        locked={remove.locked}
        pending={remove.pending}
        onRetry={remove.retry}
        onClose={remove.reset}
      />
      {failedWithoutData(page.factors) ? (
        <LoadError
          failure={failureOf(page.factors.error)}
          onRetry={() => void page.factors.refetch()}
        />
      ) : !page.ready || !page.list ? (
        <ListSkeleton label={t('security.devicesLoading')} rows={2} />
      ) : (
        <ul className={styles.list}>
          {page.list.map((factor) => (
            <FactorRow key={factor.id} factor={factor} page={page} />
          ))}
        </ul>
      )}
      {!page.single && page.ready && (
        <Button variant="secondary" block onClick={page.addDevice}>
          {t('security.add')}
        </Button>
      )}
      <p className={styles.muted}>{t('security.replaceHint')}</p>
    </section>
  )
}

function FactorRow({ factor, page }: { factor: VerifiedFactor; page: SecurityPageState }) {
  const { t } = useTranslation('pro')
  const name = factor.friendlyName || t('security.unnamed')
  const busy = page.remove.pending || page.remove.locked
  const addedOn = page.addedOn(factor.createdAt)
  return (
    <li className={styles.item}>
      <span className={styles.itemTitle}>{name}</span>
      {addedOn !== null && (
        <span className={styles.muted}>{t('security.addedOn', { date: addedOn })}</span>
      )}
      {page.confirming === factor.id ? (
        <div className={styles.stack}>
          <p className={styles.status}>{t('security.removeConfirm', { name })}</p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => page.confirmRemove(factor.id)}
            >
              {t('security.remove')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={page.cancelRemove}>
              {t('security.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Button
            variant="secondary"
            block
            disabled={busy || !page.canRemove}
            aria-label={t('security.removeLabel', { name })}
            onClick={() => page.askRemove(factor.id)}
          >
            {busy && page.remove.variables === factor.id
              ? t('security.removing')
              : t('security.remove')}
          </Button>
          {!page.canRemove && <p className={styles.muted}>{t('security.lastDevice')}</p>}
        </>
      )}
    </li>
  )
}
