import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { LOGIN_PATH } from '../loaders'
import { signOut } from '../session'

/**
 * «Αποσύνδεση από όλες τις συσκευές» (contract 1.7 §6.7, ADR-0009 §19): every push row of the user
 * goes first, then Auth ends every other session and, once it has confirmed that, this one too;
 * nothing of the user stays in memory; the login screen. Success only after Auth's answer (review
 * fix, contract §10): when it does not confirm (offline, 5xx), this device is still signed in, the
 * page says so (`failed`) and the user can try again from here.
 */
export function useSignOutAll() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => signOut({ scope: 'global' }),
    onSuccess: (result) => {
      if (!result.ok) return
      queryClient.clear()
      void navigate(LOGIN_PATH, { replace: true })
    },
  })
  return {
    signOutAll: () => mutation.mutate(),
    pending: mutation.isPending,
    /** Auth did not confirm (or the call failed): still signed in here, nothing to clear. */
    failed: mutation.isError || mutation.data?.ok === false,
    reset: () => mutation.reset(),
  } as const
}
