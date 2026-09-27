import { BookingPage } from '@/features/booking/components/BookingPage'
import { NotFoundPage } from '../shared/NotFoundPage'
import { LandingPage } from './LandingPage'
import type { BookingRoute } from './route'

export function BookingApp({ route }: { route: BookingRoute }) {
  switch (route.kind) {
    case 'landing':
      return <LandingPage />
    case 'business':
      return <BookingPage slug={route.slug} />
    case 'not-found':
      return <NotFoundPage />
  }
}
