import { useId, type InputHTMLAttributes, type Ref } from 'react'
import styles from './TextField.module.css'

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'className' | 'aria-invalid' | 'aria-describedby'
> {
  /** From i18n, like hint and error. */
  label: string
  hint?: string
  /** Shown under the field (role="alert") and marks it invalid. */
  error?: string | null
  ref?: Ref<HTMLInputElement>
}

/**
 * Labelled input: 16px text (no iOS zoom), ≥ 44px tall, border ≥ 3:1. Pass the input attributes
 * the step needs, e.g. `inputMode="numeric" autoComplete="one-time-code"` for the OTP.
 */
export function TextField({ label, hint, error, ...input }: TextFieldProps) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
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
