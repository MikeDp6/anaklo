import '@fontsource-variable/manrope'
import '@/styles/tokens.css'
import '@/styles/base.css'
import { mount } from '../shared/mount'
import { BookingApp } from './BookingApp'
import { isTrustedDeviceSpike, resolveBookingRoute } from './route'

await mount(
  <BookingApp
    route={resolveBookingRoute(window.location.pathname)}
    spike={isTrustedDeviceSpike(window.location.search)}
  />,
)
