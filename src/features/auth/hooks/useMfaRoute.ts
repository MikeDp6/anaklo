import { useLoaderData } from 'react-router'
import type { MfaRouteData } from '../loaders'

/** The session behind an `mfa/*` screen (its loader guarantees the decision it is for). */
export function useMfaRoute(): MfaRouteData {
  return useLoaderData<MfaRouteData>()
}
