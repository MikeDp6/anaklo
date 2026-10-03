import { useId, type Ref, type TextareaHTMLAttributes } from 'react'
import styles from './TextField.module.css'
import { cx } from './cx'

export interface TextAreaFieldProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'id' | 'className' | 'aria-invalid' | 'aria-describedby'
> {
  /** From i18n, like hint and error. */
  label: string
  hint?: string
  /** Shown under the field (role="alert") and marks it invalid. */
  error?: string | null
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * Labelled multi-line text (contract 1.8 §4.5): like `TextField` (label, hint and error wired the
 * same way, 16px text so iOS does not zoom, border ≥ 3:1), at least 88px tall and resizable only
 * vertically. Pass the textarea attributes the form needs, e.g. `maxLength` and `rows`.
 */
export function TextAreaField({ label, hint, error, rows = 4, ...textarea }: TextAreaFieldProps) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        className={cx(styles.input, styles.textarea)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...textarea}
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
