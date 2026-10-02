import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newIdempotencyKey } from '@/features/appointments/attemptKey'
import { useMember } from '@/features/auth/hooks/useMember'
import { LoadError } from '@/features/calendar/components/LoadError'
import { RefreshError } from '@/features/calendar/components/RefreshError'
import { failedRefresh, failedWithoutData } from '@/features/calendar/queryState'
import { useBusiness } from '@/features/settings/hooks/useBusiness'
import { SettingsHeader } from '@/features/staff/components/SettingsHeader'
import { useStaff } from '@/features/staff/hooks/useStaff'
import { failureOf } from '@/shared/lib/rpcError'
import { Button } from '@/shared/ui/Button'
import { Page } from '@/shared/ui/Page'
import { useCategories, useServiceCatalogue } from '../hooks/useServiceCatalogue'
import { groupServices } from '../serviceForm'
import { ServiceList, ServiceListSkeleton } from './ServiceList'
import { ServiceSheet, type ServiceSheetTarget } from './ServiceSheet'

/**
 * /settings/services (owner, manager; contract 1.6 §4.3): the catalogue by category, one primary
 * action «Νέα υπηρεσία», a sheet per service. Minimal motion: E16 presses, E17 skeletons.
 */
export function ServicesPage() {
  const { t } = useTranslation('pro')
  const businessId = useMember().membership.businessId
  const business = useBusiness(businessId)
  const catalogue = useServiceCatalogue(businessId)
  const categories = useCategories(businessId)
  const staff = useStaff(businessId)
  const [sheet, setSheet] = useState<ServiceSheetTarget | null>(null)

  const queries = [business, catalogue, categories, staff] as const
  const failed = queries.find(failedWithoutData)
  const refreshFailed = queries.find(failedRefresh)
  const retry = () => queries.forEach((query) => void query.refetch())
  const ready =
    business.data && catalogue.data && categories.data && staff.data
      ? {
          business: business.data,
          services: catalogue.data,
          categories: categories.data,
          staff: staff.data,
        }
      : null

  return (
    <Page busy={!ready && !failed}>
      <SettingsHeader title={t('services.title')} />
      <Button
        block
        disabled={!ready}
        onClick={() => setSheet({ kind: 'new', id: newIdempotencyKey() })}
      >
        {t('services.new')}
      </Button>
      {failed ? (
        <LoadError failure={failureOf(failed.error)} onRetry={retry} />
      ) : !ready ? (
        <ServiceListSkeleton />
      ) : (
        <>
          {refreshFailed && (
            <RefreshError failure={failureOf(refreshFailed.error)} onRetry={retry} />
          )}
          <ServiceList
            groups={groupServices(ready.services, ready.categories)}
            currency={ready.business.currency}
            onOpen={(service) => setSheet({ kind: 'edit', service })}
          />
        </>
      )}
      {ready && sheet && (
        <ServiceSheet
          businessId={businessId}
          target={sheet}
          categories={ready.categories}
          staff={ready.staff}
          currency={ready.business.currency}
          onClose={() => setSheet(null)}
        />
      )}
    </Page>
  )
}
