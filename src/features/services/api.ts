import { writeSignal } from '@/features/calendar/api'
import type { Database } from '@/shared/lib/database.types'
import { throwIfFailed } from '@/shared/lib/rpcError'
import { supabase } from '@/shared/lib/supabase'
import {
  CatalogueRows,
  CategoryRows,
  SaveServiceResponse,
  ServiceRows,
  toCatalogue,
  toCategories,
  toSaveServiceArgs,
  toSaveServiceResult,
  toServices,
  type CatalogueService,
  type Category,
  type SaveServiceInput,
  type SaveServiceResult,
  type Service,
} from './schema'

type Functions = Database['public']['Functions']
type Args<Name extends keyof Functions> = Functions[Name]['Args']

/** Active services with who offers them (contract 1.4 §3.1). */
export async function fetchServices(businessId: string, signal?: AbortSignal): Promise<Service[]> {
  let query = supabase
    .from('services')
    .select(
      'id, name, duration_min, buffer_after_min, price_cents, sort, staff_services(staff_id, custom_duration_min, custom_price_cents)',
    )
    .eq('business_id', businessId)
    .eq('active', true)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toServices(ServiceRows.parse(data))
}

/** Every service, active and inactive, with its staff terms (contract 1.6 §3.1). */
export async function fetchServiceCatalogue(
  businessId: string,
  signal?: AbortSignal,
): Promise<CatalogueService[]> {
  let query = supabase
    .from('services')
    .select(
      'id, name, category_id, duration_min, buffer_after_min, price_cents, online_bookable, active, sort, staff_services(staff_id, custom_duration_min, custom_price_cents)',
    )
    .eq('business_id', businessId)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toCatalogue(CatalogueRows.parse(data))
}

/** The provisioned categories (never created in the app). */
export async function fetchCategories(
  businessId: string,
  signal?: AbortSignal,
): Promise<Category[]> {
  let query = supabase
    .from('service_categories')
    .select('id, name, sort')
    .eq('business_id', businessId)
    .order('sort')
    .order('id')
  if (signal) query = query.abortSignal(signal)
  const { data, error, status } = await query
  throwIfFailed(error, status)
  return toCategories(CategoryRows.parse(data))
}

/**
 * The service and its complete staff list in one call (`save_service`, §2.5.5). Idempotent by
 * content: the retry of a create that committed answers `created: false`.
 */
export async function saveService(
  businessId: string,
  input: SaveServiceInput,
): Promise<SaveServiceResult> {
  const args: Args<'save_service'> = toSaveServiceArgs(businessId, input)
  const { data, error, status } = await supabase
    .rpc('save_service', args)
    .abortSignal(writeSignal())
  throwIfFailed(error, status)
  return toSaveServiceResult(SaveServiceResponse.parse(data))
}
