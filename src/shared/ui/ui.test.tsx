import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { ConfirmMark } from './ConfirmMark'
import { DisplayTitle } from './DisplayTitle'
import { Framed } from './Framed'
import { ProgressBar } from './ProgressBar'
import { TextField } from './TextField'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The texts below are test data; in the app they come from i18n.
describe('Button (G3, E1/E2/E16)', () => {
  it('is a plain button with its label announced once', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Κλείσε ραντεβού</Button>)
    const button = screen.getByRole('button', { name: 'Κλείσε ραντεβού' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('pressable')
    expect(button).not.toHaveClass('btn-fill')
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('adds the liquid fill only to the CTAs that ask for it', () => {
    render(
      <Button liquid type="submit">
        Επιβεβαίωση
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Επιβεβαίωση' })
    expect(button).toHaveClass('btn-fill', 'pressable')
    expect(button).toHaveAttribute('type', 'submit')
  })

  it('renders non-text children as they are (no roll)', () => {
    render(
      <Button aria-label="Πίσω">
        <svg aria-hidden="true" />
      </Button>,
    )
    expect(screen.getByRole('button', { name: 'Πίσω' }).querySelector('.roll')).toBeNull()
  })
})

describe('DisplayTitle (G2 + E5)', () => {
  it('is a heading named by its whole text, animated or not', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { rerender } = render(<DisplayTitle>Demo Barber</DisplayTitle>)
    expect(screen.getByRole('heading', { level: 1, name: 'Demo Barber' })).toBeInTheDocument()
    rerender(
      <DisplayTitle as="h2" animate>
        Demo Barber
      </DisplayTitle>,
    )
    expect(screen.getByRole('heading', { level: 2, name: 'Demo Barber' })).toBeInTheDocument()
  })
})

describe('ProgressBar (E19)', () => {
  it('exposes its value and moves with scaleX, clamped to 0–1', () => {
    const { rerender } = render(<ProgressBar value={2} max={4} label="Πρόοδος" valueText="2/4" />)
    const bar = screen.getByRole('progressbar', { name: 'Πρόοδος' })
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '4')
    expect(bar).toHaveAttribute('aria-valuetext', '2/4')
    expect(bar.firstElementChild).toHaveStyle({ transform: 'scaleX(0.5)' })
    rerender(<ProgressBar value={9} max={4} label="Πρόοδος" />)
    expect(bar.firstElementChild).toHaveStyle({ transform: 'scaleX(1)' })
  })
})

describe('ConfirmMark (E15)', () => {
  it('is one image with an accessible name', () => {
    render(<ConfirmMark label="Το ραντεβού κλείστηκε" />)
    const mark = screen.getByRole('img', { name: 'Το ραντεβού κλείστηκε' })
    expect(mark.querySelector('.confirm-check')).toBeInTheDocument()
    expect(mark.querySelector('.confirm-halo')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Framed (G5/E8)', () => {
  it('marks itself in view (the frame slides in via CSS)', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { container } = render(
      <Framed>
        <p>Κάρτα</p>
      </Framed>,
    )
    expect(container.firstElementChild).toHaveClass('framed')
    expect(container.firstElementChild).toHaveAttribute('data-inview', 'true')
  })
})

describe('TextField', () => {
  it('labels the input and links hint and error', () => {
    const { rerender } = render(
      <TextField label="Κινητό" hint="Θα σου στείλουμε κωδικό" type="tel" autoComplete="tel" />,
    )
    const input = screen.getByLabelText('Κινητό')
    expect(input).toHaveAttribute('type', 'tel')
    expect(input).toHaveAccessibleDescription('Θα σου στείλουμε κωδικό')
    expect(input).not.toHaveAttribute('aria-invalid')

    rerender(<TextField label="Κινητό" error="Λάθος αριθμός" type="tel" />)
    expect(screen.getByLabelText('Κινητό')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Λάθος αριθμός')
    expect(screen.getByLabelText('Κινητό')).toHaveAccessibleDescription('Λάθος αριθμός')
  })
})
