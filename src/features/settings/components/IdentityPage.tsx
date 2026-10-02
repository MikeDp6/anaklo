import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useMember } from '@/features/auth/hooks/useMember'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { SettingsHeader } from '@/features/staff/components/SettingsHeader'
import { failureOf } from '@/shared/lib/rpcError'
import { Page } from '@/shared/ui/Page'
import { useIdentity } from '../hooks/useIdentity'
import { IdentityForm } from './IdentityForm'
import { ListSkeleton } from './SettingsScreen'
import styles from './screens.module.css'

/**
 * /settings/identity (owner only, `OwnerOnly`; contract 1.7 §6.9): the booking page's address,
 * the time zone and the currency, with the consequences of a change written before it is
 * confirmed, and the former addresses that still lead here. One primary action per step.
 */
export function IdentityPage() {
  const { t } = useTranslation('pro')
  const businessId = useMember().membership.businessId
  const identity = useIdentity(businessId)
  const retry = () => void identity.refetch()

  return (
    <Page busy={identity.data === undefined && !identity.isError}>
      <SettingsHeader title={t('identity.title')} />
      <p className={styles.intro}>{t('identity.intro')}</p>
      {failedWithoutData(identity) ? (
        <LoadError failure={failureOf(identity.error)} onRetry={retry} />
      ) : identity.data === undefined ? (
        <ListSkeleton label={t('identity.loading')} />
      ) : (
        <>
          {failedRefresh(identity) && (
            <RefreshError failure={failureOf(identity.error)} onRetry={retry} />
          )}
          <IdentityForm businessId={businessId} identity={identity.data} />
          <AliasList aliases={identity.data.aliases} />
        </>
      )}
    </Page>
  )
}

/** «Παλιές διευθύνσεις που οδηγούν εδώ»: former slugs redirect to the current one (D7). */
function AliasList({ aliases }: { aliases: readonly string[] }) {
  const { t } = useTranslation('pro')
  const titleId = useId()
  if (aliases.length === 0) return null
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>
        {t('identity.aliases')}
      </h2>
      <ul className={styles.list}>
        {aliases.map((alias) => (
          <li key={alias} className={styles.meta}>
            {`${window.location.origin}/${alias}`}
          </li>
        ))}
      </ul>
    </section>
  )
}
