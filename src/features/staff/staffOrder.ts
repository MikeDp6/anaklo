/**
 * Reordering the staff with «Πάνω» / «Κάτω» (contract 1.6 §4.4): the full new id list for
 * `set_staff_order`. Pure; an id at the edge (or unknown) leaves the list as it is.
 */
export function moveUp(ids: readonly string[], id: string): string[] {
  const index = ids.indexOf(id)
  return index > 0 ? swap(ids, index - 1, index) : [...ids]
}

export function moveDown(ids: readonly string[], id: string): string[] {
  const index = ids.indexOf(id)
  return index >= 0 && index < ids.length - 1 ? swap(ids, index, index + 1) : [...ids]
}

function swap(ids: readonly string[], a: number, b: number): string[] {
  const next = [...ids]
  const first = next[a]
  const second = next[b]
  if (first === undefined || second === undefined) return next
  next[a] = second
  next[b] = first
  return next
}

/** The cached list in the order the server answered (`[{ id, sort }]`). */
export function applyOrder<T extends { readonly id: string; readonly sort: number }>(
  staff: readonly T[],
  order: readonly { readonly id: string; readonly sort: number }[],
): T[] {
  const sorts = new Map(order.map((row) => [row.id, row.sort]))
  return staff
    .map((member) => ({ ...member, sort: sorts.get(member.id) ?? member.sort }))
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
