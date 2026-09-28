import '@/styles/fonts.css'
import '@/styles/tokens.css'
import '@/styles/base.css'
import '@/shared/motion/motion.css'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { mount } from '../shared/mount'
import { BookingApp } from './BookingApp'
import { isTrustedDeviceSpike, resolveBookingRoute } from './route'

await mount(
  <BookingApp
    route={resolveBookingRoute(window.location.pathname)}
    spike={isTrustedDeviceSpike(window.location.search)}
  />,
  bookingCatalogues,
)
