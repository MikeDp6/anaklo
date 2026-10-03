import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '@/shared/ui/cx'
import styles from './Sheet.module.css'

/**
 * A bottom sheet on the native <dialog> (focus trap, Esc, top layer, inert page behind it).
 * Mounted only while open. Minimal motion level (MOTION.md §0): it appears without a slide; only
 * the E14 step changes inside it move.
 */
export function Sheet({
  title,
  onClose,
  children,
  busy = false,
  closable = true,
}: {
  /** From i18n or data. */
  title: string
  onClose: () => void
  children: ReactNode
  /** aria-busy while its content loads (E17 skeleton inside). */
  busy?: boolean
  /**
   * false while a write that must not be abandoned is in flight (an erase): the X is disabled and
   * Esc does nothing, so the sheet stays until the server answers.
   */
  closable?: boolean
}) {
  const { t } = useTranslation('pro')
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  const closableRef = useRef(closable)

  useEffect(() => {
    closeRef.current = onClose
    closableRef.current = closable
  }, [onClose, closable])

  // A LAYOUT effect: its cleanup runs while the <dialog> is still in the document (a passive
  // effect's cleanup runs after React removed it). close() on a connected modal dialog hands the
  // focus back to the element that opened it; on a detached one the focus falls to <body> and a
  // keyboard or VoiceOver user loses their place in the list.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    const onCancel = (event: Event) => {
      event.preventDefault()
      if (closableRef.current) closeRef.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open && typeof dialog.close === 'function') dialog.close()
      returnFocus(dialog, opener)
    }
  }, [])

  return (
    <dialog ref={ref} className={styles.sheet} aria-labelledby={titleId} aria-busy={busy}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={cx(styles.close, 'pressable')}
            aria-label={t('sheet.close')}
            disabled={!closable}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </dialog>
  )
}

/**
 * The focus goes back to the element that opened the sheet. A modal dialog's close() already does
 * it; this covers what it cannot: no showModal (older engines, jsdom) or a focus that stayed
 * inside the closing dialog. Only an opener still on the page, never <body>.
 */
function returnFocus(dialog: HTMLDialogElement, opener: Element | null) {
  const active = document.activeElement
  const lost = active === null || active === document.body || dialog.contains(active)
  if (lost && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
    opener.focus({ preventScroll: true })
  }
}
