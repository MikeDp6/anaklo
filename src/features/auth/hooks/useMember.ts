import { useRouteLoaderData } from 'react-router'
import { MEMBER_ROUTE_ID, type MemberContext } from '../loaders'

/** The signed-in member, for pages under the member route (its loader guarantees one). */
export function useMember(): MemberContext {
  const member = useRouteLoaderData<MemberContext>(MEMBER_ROUTE_ID)
  if (!member) throw new Error('useMember must be used under the member route')
  return member
}
