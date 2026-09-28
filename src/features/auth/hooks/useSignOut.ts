import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { LOGIN_PATH } from '../loaders'
import { signOut } from '../session'

/** The "Sign out" button: this device only (ADR-0009 §19), then back to the login screen. */
export function useSignOut() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => signOut(),
    onSettled: () => {
      // Shared shop phones: nothing of this user may stay in memory for the next one.
      queryClient.clear()
      void navigate(LOGIN_PATH, { replace: true })
    },
  })
  return { signOut: () => mutation.mutate(), pending: mutation.isPending } as const
}
