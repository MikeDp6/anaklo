import booking from './el/booking.json'
import common from './el/common.json'
import type { CatalogueSet } from './index'

/** Booking entry: `common` + `booking` only. The pro texts never reach this page (size budget). */
export const bookingCatalogues: CatalogueSet = {
  el: { common, booking },
  loadEn: async () => {
    const [enCommon, enBooking] = await Promise.all([
      import('./en/common.json'),
      import('./en/booking.json'),
    ])
    return { common: enCommon.default, booking: enBooking.default }
  },
}
