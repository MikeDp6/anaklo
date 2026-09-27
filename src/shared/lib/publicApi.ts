import type { ZodMiniType } from 'zod/mini'
import { readBookingEnv } from './env'

/**
 * Calls a public RPC through the same-origin `/api` proxy (ADR-0005/0006) with `fetch`,
 * so the booking page does not ship supabase-js. The response is validated with Zod.
 */
export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PublicApiError'
  }
}

export async function callPublicRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: ZodMiniType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { publishableKey } = readBookingEnv()
  const response = await fetch(`/api/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: publishableKey },
    body: JSON.stringify(args),
    signal: signal ?? null,
  })
  if (!response.ok)
    throw new PublicApiError(response.status, `RPC ${name} failed with ${response.status}`)
  return schema.parse(await response.json())
}
