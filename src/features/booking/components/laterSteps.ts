import { lazy } from 'react'

/**
 * The steps after the slot live in one lazy chunk (phase 1 §1.3): details, OTP, client choice and
 * the confirmation. Tapping a time prefetches it, so it is usually there before it is needed.
 */
const load = () => import('./later')

/** A failed prefetch stays silent: the step itself loads again and its ErrorBoundary answers. */
export function prefetchLaterSteps(): void {
  load().catch(() => undefined)
}

export const DetailsStep = lazy(() => load().then((module) => ({ default: module.DetailsStep })))
export const OtpStep = lazy(() => load().then((module) => ({ default: module.OtpStep })))
export const ClientChoiceStep = lazy(() =>
  load().then((module) => ({ default: module.ClientChoiceStep })),
)
export const ConfirmStep = lazy(() => load().then((module) => ({ default: module.ConfirmStep })))
