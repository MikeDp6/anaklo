import { z } from 'zod/mini'
import type { LocalDate } from '@/shared/lib/localDates'
import { callPublicRpc } from '@/shared/lib/publicApi'
import { INITIAL_DATA_ELEMENT_ID } from '../../../edge/inject.ts'
import { Catalogue, CatalogueResult, SlotRows, type Slot } from './schema'

/** Data access of the booking page (rule 2): anon RPCs through `/api`, never supabase-js. */

export function fetchCatalogue(slug: string, signal?: AbortSignal): Promise<Catalogue | null> {
  return callPublicRpc('public_booking_catalogue', { p_slug: slug }, CatalogueResult, signal)
}

const InitialBookingData = z.object({ catalogue: Catalogue })

/**
 * The catalogue the Worker injected into `/<slug>` (ADR-0008 §5), validated like a fetched one,
 * so the page renders without a first round trip. Missing, stale or invalid → `undefined`, and
 * the page fetches it instead.
 */
export function readInitialCatalogue(slug: string): Catalogue | undefined {
  const text = document.getElementById(INITIAL_DATA_ELEMENT_ID)?.textContent
  if (!text) return undefined
  try {
    const parsed = InitialBookingData.safeParse(JSON.parse(text))
    return parsed.success && parsed.data.catalogue.business.slug === slug
      ? parsed.data.catalogue
      : undefined
  } catch {
    return undefined
  }
}

export interface SlotQuery {
  slug: string
  serviceId: string
  /** null = any staff member. */
  staffId: string | null
  from: LocalDate
  to: LocalDate
}

const SLOT_CACHE_MS = 60_000
const slotCache = new Map<string, { at: number; rows: Promise<Slot[]> }>()

function slotKey(query: SlotQuery): string {
  return [query.slug, query.serviceId, query.staffId ?? 'any', query.from, query.to].join('|')
}

/**
 * Free starts (≤ 14 days per call). Answers are kept for a minute, so going back and forth
 * between steps does not refetch; `forgetSlots` drops them after a slot turned out taken.
 */
export function fetchSlots(query: SlotQuery): Promise<Slot[]> {
  const key = slotKey(query)
  const cached = slotCache.get(key)
  if (cached && Date.now() - cached.at < SLOT_CACHE_MS) return cached.rows
  const rows = callPublicRpc(
    'available_slots',
    {
      p_slug: query.slug,
      p_service_ids: [query.serviceId],
      p_staff_id: query.staffId,
      p_from: query.from,
      p_to: query.to,
    },
    SlotRows,
  )
  slotCache.set(key, { at: Date.now(), rows })
  rows.catch(() => slotCache.delete(key))
  return rows
}

export function forgetSlots(): void {
  slotCache.clear()
}

/** `/r/<code>` when the Worker could not resolve it: the slug, or null (unknown or closed). */
export function resolveShortCode(code: string, signal?: AbortSignal): Promise<string | null> {
  return callPublicRpc('public_slug_for_code', { p_code: code }, z.nullable(z.string()), signal)
}
