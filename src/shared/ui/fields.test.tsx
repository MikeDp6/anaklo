import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectField } from './SelectField'
import { SwitchField } from './SwitchField'

afterEach(() => {
  cleanup()
})

// The texts below are test data; in the app they come from i18n.
const OPTIONS = [
  { value: '', label: 'Χωρίς κατηγορία' },
  { value: 'a', label: 'Μαλλιά' },
] as const

describe('SelectField (contract 1.6 §4.2)', () => {
  it('is a labelled native select with hint and error wired like TextField', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <SelectField
        label="Κατηγορία"
        hint="Από το provisioning"
        options={OPTIONS}
        value=""
        onChange={onChange}
      />,
    )
    const select = screen.getByRole('combobox', { name: 'Κατηγορία' })
    expect(select).toHaveAccessibleDescription('Από το provisioning')
    expect(select).toHaveValue('')
    fireEvent.change(select, { target: { value: 'a' } })
    expect(onChange).toHaveBeenCalledOnce()

    rerender(
      <SelectField
        label="Κατηγορία"
        error="Λάθος"
        options={OPTIONS}
        value="a"
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('combobox', { name: 'Κατηγορία' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Λάθος')
  })
})

describe('SwitchField (contract 1.6 §4.2)', () => {
  it('is a switch named by its label; the whole row toggles it', () => {
    const onChange = vi.fn()
    render(
      <SwitchField
        label="Online κράτηση"
        hint="Στη σελίδα κράτησης"
        checked={false}
        onChange={onChange}
      />,
    )
    const toggle = screen.getByRole('switch', { name: 'Online κράτηση' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription('Στη σελίδα κράτησης')
    fireEvent.click(screen.getByText('Στη σελίδα κράτησης'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('disabled: no change', () => {
    const onChange = vi.fn()
    render(<SwitchField label="Ενεργή" checked onChange={onChange} disabled />)
    const toggle = screen.getByRole('switch', { name: 'Ενεργή' })
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})
