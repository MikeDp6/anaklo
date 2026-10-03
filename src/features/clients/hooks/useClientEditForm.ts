import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { formatPhone } from '@/shared/lib/phone'
import {
  ClientDetailsForm,
  toDetailsInput,
  type ClientDetailsValues,
  type LiveClientCard,
} from '../schema'
import { useUpdateDetails } from './useClientMutations'

/**
 * «Επεξεργασία στοιχείων» (contract 1.8 §4.7): name, mobile (optional; normalised to E.164 by
 * `phone.ts`) and message language, from the card's values. Every role may edit them (D11); the
 * database refuses identifying values on an erased row.
 */
export function useClientEditForm(businessId: string, card: LiveClientCard) {
  const { details } = card
  const form = useForm<ClientDetailsValues>({
    resolver: zodResolver(ClientDetailsForm),
    defaultValues: {
      fullName: details.fullName,
      phone: details.phoneE164 ? formatPhone(details.phoneE164) : '',
      locale: details.locale,
    },
  })
  const save = useUpdateDetails(businessId, card.clientId)
  const submit = form.handleSubmit((values) => save.submit(toDetailsInput(values)))
  return { form, save, submit, busy: save.pending || save.locked }
}
