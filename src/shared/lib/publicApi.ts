import type { ZodMiniType } from 'zod/mini'

/**
 * Calls the same-origin `/api` proxy (ADR-0005/0008) with `fetch`, so the booking page does not
 * ship supabase-js. The proxy adds the publishable key, so the page sends none. Every response
 * is validated with Zod.
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

export async function postPublicApi<T>(
  path: string,
  body: unknown,
  schema: ZodMiniType<T>,
  options: { headers?: Record<string, string>; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal ?? null,
  })
  if (!response.ok)
    throw new PublicApiError(response.status, `${path} failed with ${response.status}`)
  return schema.parse(await response.json())
}

export function callPublicRpc<T>(
  name: string,
  args: Record<string, unknown>,
  schema: ZodMiniType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return postPublicApi(`/rest/v1/rpc/${encodeURIComponent(name)}`, args, schema, { signal })
}
