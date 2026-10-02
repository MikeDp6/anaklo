import { useState } from 'react'
import { useNavigate } from 'react-router'
import { HOME_PATH } from '../loaders'
import { readPendingEnrollment } from '../pendingEnrollment'
import { tabStorage } from '../storage'

/**
 * «Πρόσθεσε δεύτερη συσκευή» (plan 1.7 «Δεύτερη συσκευή», contract 1.7 §6.5): «Προσθήκη τώρα»
 * opens the wizard (mode `second`) on the same screen; «Αργότερα» only after the explicit
 * confirmation. An enrolment of a second device in progress (the installed app reloaded) opens
 * the wizard straight away, so it can resume.
 */
export function useSecondDevice(userId: string, next: string | null) {
  const navigate = useNavigate()
  const [adding, setAdding] = useState(
    () => readPendingEnrollment(tabStorage(), userId, new Date())?.mode === 'second',
  )
  const [confirmed, setConfirmed] = useState(false)
  const leave = () => void navigate(next ?? HOME_PATH, { replace: true })
  return {
    adding,
    confirmed,
    setConfirmed,
    addNow: () => setAdding(true),
    /** Disabled until `confirmed`; the screen never lets it through without it. */
    later: () => {
      if (confirmed) leave()
    },
    done: leave,
  } as const
}
