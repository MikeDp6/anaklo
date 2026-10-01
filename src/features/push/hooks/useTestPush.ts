import { useMutation } from '@tanstack/react-query'
import { requestTestPush } from '../api'
import { testPushMessage, type TestPushMessage } from '../pushStatus'

/**
 * «Δοκιμαστική ειδοποίηση»: `request_test_push` queues one push to every device of the caller
 * (the server picks my rows), which `dispatch` sends right after the commit (contract 1.5 §2.10).
 */
export function useTestPush(businessId: string) {
  const mutation = useMutation({ mutationFn: () => requestTestPush(businessId) })
  const message: TestPushMessage | null = mutation.data
    ? testPushMessage(mutation.data)
    : mutation.isError
      ? 'push.testFailed'
      : null
  return {
    send: () => mutation.mutate(),
    pending: mutation.isPending,
    message,
  } as const
}
