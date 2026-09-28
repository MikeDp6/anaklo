// TEMPORARY: delete at the end of step 1.1, together with its PROXY_ALLOW_LIST entry
// (_shared/proxy-contract.ts) and [functions.spike-td] in supabase/config.toml.
//
// spike-td proves the trusted-device round trip through the Worker (ADR-0008 §4) before
// `public-booking` needs it: the Worker turns `x-anaklo-set-td` into the cookie and sends the
// cookie back as `x-anaklo-td`. No database. verify_jwt = false: the proxy secret is checked here.
import { z } from 'zod/mini'
import { isBase64UrlOfLength, toBase64Url } from '../_shared/base64url.ts'
import { errorResponse, json, parseJsonBody, requireMethod, requireProxy } from '../_shared/http.ts'
import { isUuid, PROXY_HEADERS } from '../_shared/proxy-contract.ts'

/** ≥ 128 bits (ADR-0006 §2): 32 random bytes, 43 base64url characters. */
const TOKEN_BYTES = 32

const Body = z.object({ business_id: z.string().check(z.refine((value) => isUuid(value))) })

Deno.serve(async (req) => {
  const proxy = requireProxy(req, Deno.env.get('PROXY_SECRET'))
  if (!proxy.ok) return proxy.response
  const method = requireMethod(req, 'POST')
  if (!method.ok) return method.response
  const body = await parseJsonBody(req, Body)
  if (!body.ok) return body.response

  // The Worker forwards only the cookie of the business in this header; the token counts only
  // for the business the request is about.
  const business = req.headers.get(PROXY_HEADERS.business)
  if (!isUuid(business) || business.toLowerCase() !== body.data.business_id.toLowerCase()) {
    return errorResponse('business_mismatch', 'x-anaklo-business must equal business_id.', 400)
  }

  if (isBase64UrlOfLength(req.headers.get(PROXY_HEADERS.trustedDevice), TOKEN_BYTES)) {
    return json({ trusted: true })
  }

  // The token travels only in the response header, which the Worker turns into the cookie and
  // strips; it never appears in the body, where page scripts could read it.
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
  return json(
    { trusted: false, issued: true },
    { headers: { [PROXY_HEADERS.setTrustedDevice]: token } },
  )
})
