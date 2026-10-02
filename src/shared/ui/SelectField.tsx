import { useId, type Ref, type SelectHTMLAttributes } from 'react'
import styles from './TextField.module.css'
import { cx } from './cx'
import own from './SelectField.module.css'

export interface SelectOption {
  readonly value: string
  /** From i18n or data. */
  readonly label: string
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'className' | 'aria-invalid' | 'aria-describedby' | 'children' | 'multiple'
> {
  /** From i18n, like hint and error. */
  label: string
  hint?: string
  /** Shown under the field (role="alert") and marks it invalid. */
  error?: string | null
  options: readonly SelectOption[]
  ref?: Ref<HTMLSelectElement>
}

/**
 * Labelled native <select> (contract 1.6 §4.2): the phone's own picker, 16px text (no iOS zoom),
 * ≥ 44px tall, the look and a11y wiring of `TextField`. Controlled (`value` + `onChange`) or
 * spread with React Hook Form's `register(…)`.
 */
export function SelectField({ label, hint, error, options, ...select }: SelectFieldProps) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <select
        id={id}
        className={cx(styles.input, own.select)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...select}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  )
}
