import { Suspense, type ComponentType } from 'react'
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary'
import { Page } from '@/shared/ui/Page'
import { canGoBack, progressOf, type Step } from '../flow/bookingReducer'
import { useBookingFlow, type BookingFlow } from '../flow/useBookingFlow'
import type { Catalogue } from '../schema'
import { BookingHeader } from './BookingHeader'
import { CoverCard } from './CoverCard'
import { ClientChoiceStep, ConfirmStep, DetailsStep, OtpStep } from './laterSteps'
import { LoadFailed } from './LoadFailed'
import { StepSkeleton } from './BookingSkeleton'
import { ServiceStep } from './ServiceStep'
import { SlotStep } from './SlotStep'
import { StaffStep } from './StaffStep'

const STEPS: Record<Step, ComponentType<{ flow: BookingFlow }>> = {
  service: ServiceStep,
  staff: StaffStep,
  slot: SlotStep,
  details: DetailsStep,
  otp: OtpStep,
  client: ClientChoiceStep,
  done: ConfirmStep,
}

/** The booking flow of one business: E13 header with E19 progress, the cover, the current step. */
export function BookingFlowView({ catalogue }: { catalogue: Catalogue }) {
  const flow = useBookingFlow(catalogue)
  const { state, dispatch } = flow
  const Current = STEPS[state.step]

  return (
    <>
      <BookingHeader
        name={catalogue.business.name}
        showName={state.step !== 'service'}
        onBack={canGoBack(state) ? () => dispatch({ type: 'back' }) : null}
        progress={progressOf(state)}
      />
      <Page>
        {state.step === 'service' && <CoverCard business={catalogue.business} />}
        {/* The later steps are a lazy chunk: if it cannot load, say so instead of a blank page.
            Keyed by step, so «back» to a step of the main chunk works again. */}
        <ErrorBoundary
          key={state.step}
          fallback={<LoadFailed phone={catalogue.business.phone_e164} />}
        >
          <Suspense fallback={<StepSkeleton />}>
            {/* A new key per step replays E14; the same step (e.g. a new OTP code) stays put. */}
            <Current key={state.step} flow={flow} />
          </Suspense>
        </ErrorBoundary>
      </Page>
    </>
  )
}
