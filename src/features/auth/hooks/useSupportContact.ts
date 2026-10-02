import { useState } from 'react'
import { readSupportContact, type SupportContact } from '@/shared/lib/env'

/** Nous's contact for «Χάσατε τη συσκευή σας;», read once per screen (build-time values). */
export function useSupportContact(): SupportContact {
  const [contact] = useState(() => readSupportContact())
  return contact
}
