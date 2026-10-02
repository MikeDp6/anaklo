import type { ReactNode } from 'react'
import { useStepUpController } from '../hooks/useStepUpController'
import { StepUpContext } from '../stepUpContext'
import { StepUpSheet } from './StepUpSheet'

/**
 * The app's one code sheet (contract 1.7 §6.6), around every route of `ProShell`: `useStepUp`
 * anywhere below opens it when the server asks for a fresh code, and every request of that
 * moment waits for the same sheet.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { deps, request, finish } = useStepUpController()
  return (
    <StepUpContext value={deps}>
      {children}
      {request && (
        <StepUpSheet
          factors={request.factors}
          onVerified={() => finish(true)}
          onCancel={() => finish(false)}
        />
      )}
    </StepUpContext>
  )
}
