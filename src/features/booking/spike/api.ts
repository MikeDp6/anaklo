// TEMPORARY (step 1.1 device test of the trusted-device cookie, ADR-0006/0008 §4).
// Delete this folder, the `spike` i18n keys and the `?spike=td` switch after the 1.10 device tests.
import { z } from 'zod/mini'
import { postPublicApi } from '@/shared/lib/publicApi'

/** A fixed business id for the spike only: the cookie is `__Host-td_<this id>`. */
export const SPIKE_TD_BUSINESS_ID = '5e1f7e57-0000-4000-8000-000000000001'

const SpikeTdResult = z.object({
  trusted: z.optional(z.boolean()),
  issued: z.optional(z.boolean()),
})

export type SpikeTdStatus = 'trusted' | 'issued' | 'none'

/** Asks `spike-td` (through the Worker) whether this device already holds a token. */
export async function checkTrustedDevice(signal?: AbortSignal): Promise<SpikeTdStatus> {
  const result = await postPublicApi(
    '/functions/v1/spike-td',
    { business_id: SPIKE_TD_BUSINESS_ID },
    SpikeTdResult,
    { headers: { 'x-anaklo-business': SPIKE_TD_BUSINESS_ID }, signal },
  )
  if (result.trusted) return 'trusted'
  return result.issued ? 'issued' : 'none'
}
