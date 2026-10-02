/**
 * The staff colour palette of `StaffSheet` (contract 1.6 §4.4): 8 colours, each ≥ 3:1 against
 * `--color-surface` (a non-text indicator, WCAG 1.4.11; colors.test.ts checks it). The first three
 * are those of the provisioning example, so a provisioned shop shows them as palette swatches.
 */
export const STAFF_COLORS = [
  { id: 'green', hex: '#2F6B5E' },
  { id: 'brown', hex: '#8A5A44' },
  { id: 'blue', hex: '#4F7CAC' },
  { id: 'purple', hex: '#7B4F9E' },
  { id: 'red', hex: '#B54A3C' },
  { id: 'orange', hex: '#A8641C' },
  { id: 'teal', hex: '#2A7F86' },
  { id: 'slate', hex: '#5C6670' },
] as const

export type StaffColorId = (typeof STAFF_COLORS)[number]['id']

/** The palette colour of `hex` (case-insensitive), or null for another or no colour. */
export function paletteColor(hex: string | null): (typeof STAFF_COLORS)[number] | null {
  if (!hex) return null
  return STAFF_COLORS.find((color) => color.hex.toLowerCase() === hex.toLowerCase()) ?? null
}

/** A new staff member gets the first palette colour nobody uses yet (else the first). */
export function firstFreeColor(used: readonly (string | null)[]): string {
  const taken = new Set(used.flatMap((hex) => (hex ? [hex.toLowerCase()] : [])))
  return (STAFF_COLORS.find((color) => !taken.has(color.hex.toLowerCase())) ?? STAFF_COLORS[0]).hex
}
