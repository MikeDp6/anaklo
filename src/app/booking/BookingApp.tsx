import { lazy, Suspense } from 'react'
import { BookingPage } from '@/features/booking/components/BookingPage'
import { NotFoundPage } from '../shared/NotFoundPage'
import { LandingPage } from './LandingPage'
import type { BookingRoute } from './route'

// TEMPORARY (step 1.1 trusted-device spike): a separate chunk, loaded only with `?spike=td`.
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
            <Suspense fallback={null}>
              <SpikeTdPanel />
            </Suspense>
          )}
        </>
      )
    case 'not-found':
      return <NotFoundPage />
  }
}
