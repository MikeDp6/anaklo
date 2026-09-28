import { lazy, Suspense } from 'react'
import { BookingSkeleton } from '@/features/booking/components/BookingSkeleton'
import { BookingPage } from '@/features/booking/components/BookingPage'
import { LoadFailed } from '@/features/booking/components/LoadFailed'
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary'
import { Page } from '@/shared/ui/Page'
import { NotFoundPage } from '../shared/NotFoundPage'
import { LandingPage } from './LandingPage'
import type { BookingRoute } from './route'
import { ShortLinkPage } from './ShortLinkPage'

/** The manage link has its own chunk: a booking visitor never downloads it (phase 1 §1.3). */
const ManagePage = lazy(() => import('@/features/booking/manage/ManagePage'))

// TEMPORARY (until the 1.10 device tests): a separate chunk, loaded only with `?spike=td`.
const SpikeTdPanel = lazy(() => import('@/features/booking/spike/SpikeTdPanel'))

export function BookingApp({ route, spike = false }: { route: BookingRoute; spike?: boolean }) {
  switch (route.kind) {
    case 'landing':
      return <LandingPage />
    case 'business':
      return (
        <>
          <BookingPage slug={route.slug} />
          {spike && (
            <ErrorBoundary fallback={null}>
              <Suspense fallback={null}>
                <SpikeTdPanel />
              </Suspense>
            </ErrorBoundary>
          )}
        </>
      )
    case 'manage':
      // Its own chunk: if it cannot load, a notice with a reload instead of a blank page (the
      // link may be the client's only way to cancel).
      return (
        <ErrorBoundary
          fallback={
            <Page>
              <LoadFailed headingLevel={1} />
            </Page>
          }
        >
          <Suspense fallback={<BookingSkeleton />}>
            <ManagePage token={route.token} />
          </Suspense>
        </ErrorBoundary>
      )
    case 'short-link':
      return <ShortLinkPage code={route.code} />
    case 'not-found':
      return <NotFoundPage />
  }
}
