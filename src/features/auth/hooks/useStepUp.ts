import { useCallback, useContext } from 'react'
import { withStepUp } from '../step-up'
import { StepUpContext } from '../stepUpContext'

export type StepUp = <T>(call: () => Promise<T>) => Promise<T>

/**
 * `withStepUp` bound to the app's code sheet and route guards (contract 1.7 §6.6). Wrap every
 * call of a critical action: `stepUp(() => removeFactor(id))`. The sheet opens only when the
 * server answers with one of the two step-up hints; then the call runs exactly once more.
 */
export function useStepUp(): StepUp {
  const deps = useContext(StepUpContext)
  if (!deps) throw new Error('useStepUp must be used under StepUpProvider')
  return useCallback(<T>(call: () => Promise<T>) => withStepUp(call, deps), [deps])
}
