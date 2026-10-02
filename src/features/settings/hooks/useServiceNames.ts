import { useMemo } from 'react'
import { useServiceCatalogue } from '@/features/services/hooks/useServiceCatalogue'

/**
 * `service id → name` for the conflict rows, inactive services included (an old appointment
 * keeps its service). Until the catalogue loads (or if it fails) the rows show without names.
 */
export function useServiceNames(businessId: string): ReadonlyMap<string, string> {
  const catalogue = useServiceCatalogue(businessId)
  return useMemo(
    () => new Map((catalogue.data ?? []).map((service) => [service.id, service.name])),
    [catalogue.data],
  )
}
