import { useTranslation } from 'react-i18next'
import forms from '@/features/appointments/components/forms.module.css'
import { STAFF_COLORS, paletteColor } from '../colors'
import styles from './ColorField.module.css'

/**
 * The staff colour (contract 1.6 §4.4): radio swatches of the palette, the current colour when it
 * is not one of them (e.g. from provisioning), and «Χωρίς χρώμα». Each swatch ≥ 44px, named.
 */
export function ColorField({
  value,
  onChange,
  current,
  disabled,
  name = 'staff-color',
}: {
  /** '' = no colour. */
  value: string
  onChange: (value: string) => void
  /** The stored colour of the staff member being edited. */
  current: string | null
  disabled: boolean
  name?: string
}) {
  const { t } = useTranslation('pro')
  const options = [
    ...STAFF_COLORS.map((color) => ({
      value: color.hex,
      label: t(`staffSettings.colors.${color.id}`),
    })),
    ...(current && !paletteColor(current)
      ? [{ value: current, label: t('staffSettings.colors.current') }]
      : []),
    { value: '', label: t('staffSettings.colors.none') },
  ]
  return (
    <fieldset className={forms.fieldset} disabled={disabled}>
      <legend className={forms.legend}>{t('staffSettings.fields.color')}</legend>
      <div className={styles.swatches}>
        {options.map((option) => (
          <label key={option.value || 'none'} className={styles.swatch} title={option.label}>
            <input
              type="radio"
              className={styles.input}
              name={name}
              value={option.value}
              checked={value.toLowerCase() === option.value.toLowerCase()}
              onChange={() => onChange(option.value)}
            />
            <span
              className={styles.color}
              data-none={option.value === '' || undefined}
              style={option.value ? { '--swatch': option.value } : undefined}
              aria-hidden="true"
            />
            <span className="visually-hidden">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
