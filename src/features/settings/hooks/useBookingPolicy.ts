import { useQuery } from '@tanstack/react-query'
import { proKeys } from '@/shared/lib/proQueryKeys'
import { useSettingsMutation } from '@/shared/lib/useSettingsMutation'
import { fetchBookingPolicy, updateBookingPolicy } from '../api'
import { invalidateBusinessPolicy } from '../invalidate'
import type { BookingPolicy, BookingPolicyInput } from '../schema'

/** The booking-policy columns of the business (contract 1.6 §3.3: 60″ fresh, refetch on focus). */
export function useBookingPolicy(businessId: string) {
  return useQuery({
    queryKey: proKeys.bookingPolicy(businessId),
    queryFn: ({ signal }) => fetchBookingPolicy(businessId, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** Saves every policy field; the caller refills its form from the server's answer. */
export function useUpdateBookingPolicy(
  businessId: string,
  onSuccess?: (policy: BookingPolicy) => void,
) {
  return useSettingsMutation<BookingPolicyInput, BookingPolicy>({
    mutationFn: (input) => updateBookingPolicy(businessId, input),
    invalidate: (queryClient) => invalidateBusinessPolicy(queryClient, businessId),
    onSuccess,
  })
}
