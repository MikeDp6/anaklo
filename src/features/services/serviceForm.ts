import type { StaffMember } from '@/features/staff/schema'
import { formatMoneyInput } from '@/shared/lib/money'
import type { CatalogueService, Category, ServiceFormValues } from './schema'

/**
 * Who appears under «Ποιοι την κάνουν»: every active staff member, and an inactive one only when
 * already linked (marked «ανενεργός»), in the staff order.
 */
export function offerStaff(
  service: CatalogueService | null,
  staff: readonly StaffMember[],
): StaffMember[] {
  const linked = new Set(service?.offers.map((offer) => offer.staffId) ?? [])
  return staff.filter((member) => member.active || linked.has(member.id))
}

/**
 * The form of an existing service, or of a new one (30′, no break, active, online, offered by every
 * active staff member). Money is prefilled with `formatMoneyInput` (13,00 / 13.00).
 */
export function toServiceForm(
  service: CatalogueService | null,
  staff: readonly StaffMember[],
  locale: string,
): ServiceFormValues {
  const money = (cents: number | null) => (cents === null ? '' : formatMoneyInput(cents, locale))
  const offers = offerStaff(service, staff).map((member) => {
    const terms = service?.offers.find((offer) => offer.staffId === member.id)
    return {
      staffId: member.id,
      checked: service ? terms !== undefined : member.active,
      customDurationMin:
        terms?.customDurationMin === null || terms === undefined
          ? ''
          : String(terms.customDurationMin),
      customPriceCents: money(terms?.customPriceCents ?? null),
    }
  })
  if (!service) {
    return {
      name: '',
      categoryId: '',
      durationMin: '30',
      bufferAfterMin: '0',
      priceCents: '',
      onlineBookable: true,
      active: true,
      offers,
    }
  }
  return {
    name: service.name,
    categoryId: service.categoryId ?? '',
    durationMin: String(service.durationMin),
    bufferAfterMin: String(service.bufferAfterMin),
    priceCents: money(service.priceCents),
    onlineBookable: service.onlineBookable,
    active: service.active,
    offers,
  }
}

export type ServiceGroup =
  | {
      readonly kind: 'category'
      readonly category: Category
      readonly services: CatalogueService[]
    }
  | { readonly kind: 'none'; readonly services: CatalogueService[] }
  | { readonly kind: 'inactive'; readonly services: CatalogueService[] }

/**
 * `ServiceList` groups (contract 1.6 §4.3): active services under their category (category order),
 * «Χωρίς κατηγορία» after them, «Ανενεργές» last; inside a group the catalogue order (`sort`).
 * Empty groups are left out.
 */
export function groupServices(
  services: readonly CatalogueService[],
  categories: readonly Category[],
): ServiceGroup[] {
  const ordered = [...services].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
  const active = ordered.filter((service) => service.active)
  const known = new Set(categories.map((category) => category.id))
  const groups: ServiceGroup[] = [...categories]
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
    .map((category) => ({
      kind: 'category' as const,
      category,
      services: active.filter((service) => service.categoryId === category.id),
    }))
  groups.push({
    kind: 'none',
    services: active.filter(
      (service) => service.categoryId === null || !known.has(service.categoryId),
    ),
  })
  groups.push({ kind: 'inactive', services: ordered.filter((service) => !service.active) })
  return groups.filter((group) => group.services.length > 0)
}
