/** Joins class names, skipping falsy ones: `cx(styles.a, on && styles.b, 'pressable')`. */
export function cx(...names: ReadonlyArray<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}
