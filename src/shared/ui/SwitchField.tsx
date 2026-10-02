import { useId } from 'react'
import styles from './SwitchField.module.css'

/**
 * An on/off setting (contract 1.6 §4.2): a native checkbox with `role="switch"`, drawn as a
 * switch; the whole row (label, hint, switch) is one ≥ 44px tap target. The thumb jumps, it never
 * slides (minimal motion level).
 */
export function SwitchField({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  name,
}: {
  /** From i18n, like the hint. */
  label: string
  hint?: string | null
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  name?: string
}) {
  const labelId = useId()
  const hintId = useId()
  return (
    <label className={styles.row} data-disabled={disabled || undefined}>
      <span className={styles.text}>
        <span id={labelId} className={styles.label}>
          {label}
        </span>
        {hint && (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        name={name}
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => {
          if (!disabled) onChange(event.currentTarget.checked)
        }}
      />
    </label>
  )
}
