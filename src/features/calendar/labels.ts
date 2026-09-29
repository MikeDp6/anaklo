import type { Workspace } from './hooks/useWorkspace'

/** Service names of an appointment, from the catalogue (an inactive service shows as «—»). */
export function serviceNamesOf(
  workspace: Pick<Workspace, 'services'>,
  serviceIds: readonly string[],
): string {
  return serviceIds
    .map((id) => workspace.services.find((service) => service.id === id)?.name ?? '—')
    .join(', ')
}

/** A staff member's name, also for inactive staff (old appointments keep theirs). */
export function staffNameOf(workspace: Pick<Workspace, 'staff'>, staffId: string): string {
  return workspace.staff.find((member) => member.id === staffId)?.displayName ?? ''
}
