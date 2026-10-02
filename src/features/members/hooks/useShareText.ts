import { useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * «Κοινοποίηση» (the phone's share sheet, only where the browser has one) and «Αντιγραφή
 * κειμένου» for the invitation text. A share the user dismisses is not an error; a refused
 * clipboard says so, and the text stays selectable on screen.
 */
export function useShareText(text: string) {
  const [copy, setCopy] = useState<CopyState>('idle')
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const share = () => {
    if (!canShare) return
    navigator.share({ text }).catch(() => {
      // Dismissed or refused by the browser: nothing to report, the copy button is there.
    })
  }

  const copyText = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clipboard) {
      setCopy('failed')
      return
    }
    clipboard.writeText(text).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    )
  }

  return { canShare, share, copy, copyText }
}
