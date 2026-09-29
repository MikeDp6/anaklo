import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatShortDate, useAppLocale } from '@/features/calendar/format'
import { useClientSearch } from '@/features/clients/hooks/useClientSearch'
import { MAX_SEARCH_LENGTH } from '@/features/clients/schema'
import { toLocalDate } from '@/shared/lib/dates'
import { formatPhone } from '@/shared/lib/phone'
import { failureOf, rpcFailureMessageKey } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Skeleton } from '@/shared/ui/Skeleton'
import { TextField } from '@/shared/ui/TextField'
import { cx } from '@/shared/ui/cx'
import type { QuickAddFlow } from '../hooks/useQuickAddFlow'
import type { QuickAddErrorKey } from '../quickAddSchema'
import styles from './forms.module.css'

/** Step 1: find the client (name, Greeklish, last digits) or add a new one inline. */
export function ClientStep({
  businessId,
  timeZone,
  flow,
}: {
  businessId: string
  timeZone: string
  flow: QuickAddFlow
}) {
  const { t } = useTranslation(['pro', 'common'])
  const locale = useAppLocale()
  const [query, setQuery] = useState(
    flow.values.clientMode === 'existing' ? '' : flow.values.clientName,
  )
  const search = useClientSearch(businessId, query)
  const { errors } = flow.form.formState
  const errorText = (key: string | undefined) => (key ? t(key as QuickAddErrorKey) : null)

  // The keys keep React from reusing the search box (controlled) as the name field (registered,
  // uncontrolled) and back: a switch mounts fresh inputs.
  if (flow.values.clientMode === 'new') {
    return (
      <div key="new" className={styles.stack}>
        <TextField
          label={t('quickAdd.fullName')}
          autoComplete="off"
          autoCapitalize="words"
          error={errorText(errors.clientName?.message)}
          {...flow.form.register('clientName')}
        />
        <TextField
          label={t('quickAdd.phone')}
          hint={t('quickAdd.phoneHint')}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          error={errorText(errors.phone?.message)}
          {...flow.form.register('phone')}
        />
        <Button onClick={() => void flow.confirmNewClient()} block>
          {t('quickAdd.continue')}
        </Button>
        <Button variant="secondary" onClick={flow.backToSearch} block>
          {t('quickAdd.backToSearch')}
        </Button>
      </div>
    )
  }

  // No search (fewer than 2 characters): no results, never those of an earlier query.
  const hits = search.enabled ? (search.data ?? []) : []
  return (
    <div key="search" className={styles.stack}>
      <TextField
        label={t('quickAdd.search')}
        hint={t('quickAdd.searchHint')}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={MAX_SEARCH_LENGTH}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault()
        }}
      />
      {search.enabled && search.isPending ? (
        <div className={styles.actions} aria-busy="true">
          <span className="visually-hidden" role="status">
            {t('quickAdd.searching')}
          </span>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </div>
      ) : search.enabled && search.isError ? (
        <p role="alert" className={styles.error}>
          {t(rpcFailureMessageKey(failureOf(search.error), 'read'))}
        </p>
      ) : search.enabled && hits.length === 0 ? (
        <p className={styles.muted} role="status">
          {t('quickAdd.noResults')}
        </p>
      ) : (
        <ul className={styles.actions} aria-label={t('quickAdd.results')} role="list">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className={cx(styles.option, 'pressable')}
                onClick={() => flow.pickClient(hit)}
              >
                <span className={styles.optionMain}>
                  <span className={styles.optionTitle}>{hit.fullName}</span>
                  <span className={styles.optionMeta}>
                    {[
                      hit.phoneE164 ? formatPhone(hit.phoneE164) : null,
                      hit.lastVisitAt
                        ? t('quickAdd.lastVisit', {
                            date: formatShortDate(
                              toLocalDate(new Date(hit.lastVisitAt), timeZone),
                              locale,
                            ),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" onClick={() => flow.startNewClient(query)} block>
        {t('quickAdd.newClient')}
      </Button>
    </div>
  )
}
