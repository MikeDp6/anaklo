import { createContext } from 'react'
import type { StepUpDeps } from './step-up'

/**
 * The code sheet of the app (contract 1.7 §6.6): `StepUpProvider` (in `ProShell`, around every
 * route) supplies it; `useStepUp` binds `withStepUp` to it.
 */
export const StepUpContext = createContext<StepUpDeps | null>(null)
