import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectField } from './SelectField'
import { SwitchField } from './SwitchField'
import { TextAreaField } from './TextAreaField'
import { TextField } from './TextField'

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

describe('TextAreaField (contract 1.8 §4.5)', () => {
  it('is a labelled textarea with hint and error wired like TextField', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <TextAreaField
        label="Σημείωση"
        hint="Μόνο ό,τι βοηθά"
        maxLength={2000}
        onChange={onChange}
      />,
    )
    const box = screen.getByRole('textbox', { name: 'Σημείωση' })
    expect(box.tagName).toBe('TEXTAREA')
    expect(box).toHaveAccessibleDescription('Μόνο ό,τι βοηθά')
    expect(box).toHaveAttribute('maxlength', '2000')
    expect(box).not.toHaveAttribute('aria-invalid')
    fireEvent.change(box, { target: { value: 'Κοντά στο πλάι' } })
    expect(onChange).toHaveBeenCalledOnce()

    rerender(<TextAreaField label="Σημείωση" error="Γράψε τη σημείωση." onChange={onChange} />)
    expect(screen.getByRole('textbox', { name: 'Σημείωση' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Γράψε τη σημείωση.')
  })

  it('has the 16px input class of TextField (no iOS zoom) and is at least 88px tall', () => {
    render(
      <>
        <TextField label="Όνομα" />
        <TextAreaField label="Σημείωση" />
      </>,
    )
    const inputClass = screen.getByRole('textbox', { name: 'Όνομα' }).className
    const box = screen.getByRole('textbox', { name: 'Σημείωση' })
    expect(inputClass).not.toBe('')
    expect(box.className.split(' ')).toContain(inputClass)
    const css = readFileSync(
      join(process.cwd(), 'src', 'shared', 'ui', 'TextField.module.css'),
      'utf8',
    )
    expect(css).toMatch(/\.input \{[^}]*font-size: max\(16px/)
    expect(css).toMatch(/\.textarea \{[^}]*min-height: 88px/)
  })
})
