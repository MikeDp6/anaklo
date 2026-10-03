import { useTranslation } from 'react-i18next'
import { failureOf, rpcFailureMessageKey } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { DisplayTitle } from '@/shared/ui/DisplayTitle'
import { Page } from '@/shared/ui/Page'
import { Skeleton } from '@/shared/ui/Skeleton'
import { TextField } from '@/shared/ui/TextField'
import { useClientsPage } from '../hooks/useClientsPage'
import { MAX_SEARCH_LENGTH } from '../schema'
import { ClientHitList } from './ClientHitList'
import styles from './clients.module.css'

/**
 * «Πελάτες» (contract 1.8 §4.2): one box (the screen's one action) that finds a client by name
 * in Greek, capitals or Greeklish, or by the last digits of the phone (`search_clients`); each
 * result opens the card. While the first results load: two E17 rows of the results' height.
 */
export function ClientsPage() {
  const { t } = useTranslation(['pro', 'common'])
  const page = useClientsPage()
  const { search, hits } = page
  const loading = search.enabled && search.isPending

  return (
    <Page busy={loading}>
      <DisplayTitle size="md">{t('clients.title')}</DisplayTitle>
      {page.erased && (
        <p role="status" className={styles.status}>
          {t('clients.search.erased')}
        </p>
      )}
      <TextField
        label={t('clients.search.label')}
        hint={t('clients.search.hint')}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={MAX_SEARCH_LENGTH}
        value={page.query}
        onChange={(event) => page.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
      {loading ? (
        <div className={styles.hits} role="status">
          <span className="visually-hidden">{t('clients.search.searching')}</span>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : search.enabled && search.isError && search.data === undefined ? (
        <div className={styles.stack}>
          <p role="alert" className={styles.error}>
            {t(rpcFailureMessageKey(failureOf(search.error), 'read'))}
          </p>
          <Button variant="secondary" onClick={() => void search.refetch()}>
            {t('common:retry')}
          </Button>
        </div>
      ) : search.enabled && hits.length === 0 ? (
        <p role="status" className={styles.muted}>
          {t('clients.search.none')}
        </p>
      ) : (
        hits.length > 0 && <ClientHitList hits={hits} timeZone={page.timeZone} back={page.back} />
      )}
    </Page>
  )
}
