// health: proves that the functions are deployed, that the proxy secret matches and where they
// run (ADR-0008 §3). No data. verify_jwt = false (supabase/config.toml): the `/api` proxy sends
// the publishable key, not a user JWT; the proxy secret is checked here instead.
import { json, requireMethod, requireProxy } from '../_shared/http.ts'

const REGION = /^[a-z0-9-]{1,32}$/

function runtimeRegion(): string | null {
  const region = Deno.env.get('SB_REGION') ?? Deno.env.get('DENO_REGION') ?? ''
  return REGION.test(region) ? region : null
}

Deno.serve((req) => {
  const proxy = requireProxy(req, Deno.env.get('PROXY_SECRET'))
  if (!proxy.ok) return proxy.response
  const method = requireMethod(req, 'GET')
  if (!method.ok) return method.response

  const region = runtimeRegion()
  return json(region === null ? { ok: true } : { ok: true, region })
})
