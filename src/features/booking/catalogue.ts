import type { Catalogue, CatalogueService, CatalogueStaff } from './schema'

/** Read-only questions the booking steps ask of the catalogue (pure, tested). */

export interface ServiceGroup {
  /** null: services without a category (listed first, without a heading). */
  category: { id: string; name: string } | null
  services: CatalogueService[]
}

export function serviceGroups(catalogue: Catalogue): ServiceGroup[] {
  const groups: ServiceGroup[] = []
  const loose = catalogue.services.filter((service) => service.category_id === null)
  if (loose.length > 0) groups.push({ category: null, services: loose })
  for (const category of catalogue.categories) {
    const services = catalogue.services.filter((service) => service.category_id === category.id)
    if (services.length > 0) groups.push({ category, services })
  }
  return groups
}

export function findService(catalogue: Catalogue, serviceId: string | null) {
  return catalogue.services.find((service) => service.id === serviceId)
}

export function findStaff(catalogue: Catalogue, staffId: string | null) {
  return catalogue.staff.find((member) => member.id === staffId)
}

/** Staff members who offer the service online. */
export function staffForService(catalogue: Catalogue, serviceId: string): CatalogueStaff[] {
  return catalogue.staff.filter((member) =>
    member.services.some((terms) => terms.service_id === serviceId),
  )
}

/**
 * The staff step shows only when there is a choice (≥ 2 staff for the service); with one, that
 * member is chosen for the visitor. «Any staff» is offered only with `allow_any_staff`.
 */
export function staffPlan(
  catalogue: Catalogue,
  serviceId: string,
): { staffStep: boolean; staffId: string | null } {
  const eligible = staffForService(catalogue, serviceId)
  if (eligible.length >= 2) return { staffStep: true, staffId: null }
  return { staffStep: false, staffId: eligible[0]?.id ?? null }
}

/** Duration and price of the service with that staff member (their custom terms), else the defaults. */
export function termsFor(
  catalogue: Catalogue,
  serviceId: string,
  staffId: string | null,
): { duration_min: number; price_cents: number } | null {
  const service = findService(catalogue, serviceId)
  if (!service) return null
  const terms = findStaff(catalogue, staffId)?.services.find((t) => t.service_id === serviceId)
  return terms ?? { duration_min: service.duration_min, price_cents: service.price_cents }
}

/** One letter for the staff avatar (no photos in Phase 1). */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? ''
}
