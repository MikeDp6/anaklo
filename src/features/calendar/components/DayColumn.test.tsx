import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { IDS, testAppointment, testWorkspace } from '@/features/appointments/testFixtures'
import { initI18n } from '@/shared/i18n'
import { proCatalogues } from '@/shared/i18n/pro'
import type { DayFrame } from '../schema'
import { DayColumn, PX_PER_MINUTE } from './DayColumn'

// Test data only: 29 September 2026 in Athens (UTC+3), the day drawn from 09:00 to 12:00.
const FRAME: DayFrame = {
  localDate: '2026-09-29',
  timeZone: 'Europe/Athens',
  dayStart: '2026-09-28T21:00:00+00:00',
  dayEnd: '2026-09-29T21:00:00+00:00',
  windows: [],
  blocks: [],
}
const RANGE = { fromMin: 9 * 60, toMin: 12 * 60 }
/** The .slot around each button has 1px padding on each side (DayView.module.css). */
const SLOT_PADDING_PX = 2
const MIN_TAP_PX = 44

beforeAll(async () => {
  await initI18n(proCatalogues)
})

afterEach(() => {
  cleanup()
})

describe('DayColumn', () => {
  it('a 15′ appointment is still a ≥ 44px button (one-handed use, CLAUDE.md)', () => {
    const beard = testAppointment({
      startsAt: '2026-09-29T07:00:00+00:00', // 10:00
      endsAt: '2026-09-29T07:15:00+00:00',
      services: [{ position: 0, serviceId: IDS.beard, durationMin: 15, priceCents: 700 }],
    })
    const workspace = testWorkspace()
    render(
      <DayColumn
        column={{
          staff: workspace.staff[0]!,
          readable: true,
          appointments: [beard],
          blocks: [],
          windows: [],
        }}
        frame={FRAME}
        range={RANGE}
        workspace={workspace}
        onOpen={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: /Γιώργος Π\./ })
    const slot = button.parentElement
    if (!slot) throw new Error('no slot')
    const drawn = Number.parseFloat(slot.style.height)
    expect(drawn - SLOT_PADDING_PX).toBeGreaterThanOrEqual(MIN_TAP_PX)
    expect(drawn / PX_PER_MINUTE).toBeGreaterThan(15)
  })
})
