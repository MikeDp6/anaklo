import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import { Sheet } from './Sheet'

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
})

/** A list row that opens a sheet; the parent unmounts the sheet on close, as the pages do. */
function Screen() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        10:00 Γιώργος Π.
      </button>
      {open && (
        <Sheet title="Ραντεβού" onClose={() => setOpen(false)}>
          <button type="button" onClick={() => setOpen(false)}>
            Τέλος
          </button>
        </Sheet>
      )}
    </>
  )
}

describe('Sheet', () => {
  it('gives the focus back to the element that opened it (X)', () => {
    render(<Screen />)
    const opener = screen.getByRole('button', { name: '10:00 Γιώργος Π.' })
    opener.focus()
    fireEvent.click(opener)
    const close = screen.getByRole('button', { name: 'Κλείσιμο' })
    close.focus()
    fireEvent.click(close)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('closable={false}: the X is disabled and Esc does nothing', () => {
    const onClose = vi.fn()
    render(
      <Sheet title="Ανωνυμοποίηση" onClose={onClose} closable={false}>
        <p>…</p>
      </Sheet>,
    )
    const close = screen.getByRole('button', { name: 'Κλείσιμο' })
    expect(close).toBeDisabled()
    fireEvent.click(close)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('also when a control inside the sheet closes it («Τέλος»)', () => {
    render(<Screen />)
    const opener = screen.getByRole('button', { name: '10:00 Γιώργος Π.' })
    opener.focus()
    fireEvent.click(opener)
    const done = screen.getByRole('button', { name: 'Τέλος' })
    done.focus()
    fireEvent.click(done)
    expect(document.activeElement).toBe(opener)
  })
})
