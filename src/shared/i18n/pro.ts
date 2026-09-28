import booking from './el/booking.json'
import common from './el/common.json'
import pro from './el/pro.json'
import type { CatalogueSet } from './index'

/** Pro app entry: every namespace. */
export const proCatalogues: CatalogueSet = {
  el: { common, booking, pro },
  loadEn: async () => {
    const [enCommon, enBooking, enPro] = await Promise.all([
      import('./en/common.json'),
      import('./en/booking.json'),
      import('./en/pro.json'),
    ])
    return { common: enCommon.default, booking: enBooking.default, pro: enPro.default }
  },
}
