import { cleanup, render, screen } from '@testing-library/react'
import { lazy, Suspense } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '@/shared/i18n'
import { bookingCatalogues } from '@/shared/i18n/booking'
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary'
import { LoadFailed } from './LoadFailed'

beforeAll(async () => {
  await initI18n(bookingCatalogues)
})

afterEach(() => {
  cleanup()
})

describe('a lazy chunk that does not load', () => {
  it('shows a notice with a retry and the shop phone instead of a blank page', async () => {
    // React reports the caught error on the console; that is expected here.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const Missing = lazy(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    )
    const retry = vi.fn()
    render(
      <main>
        <p>Κεφαλίδα</p>
        <ErrorBoundary fallback={<LoadFailed phone="+302610000000" onRetry={retry} />}>
          <Suspense fallback={<p>…</p>}>
            <Missing />
          </Suspense>
        </ErrorBoundary>
      </main>,
    )

    expect(await screen.findByRole('heading', { name: 'Δεν φόρτωσε η σελίδα' })).toBeInTheDocument()
    expect(screen.getByText('Κεφαλίδα')).toBeInTheDocument() // the rest of the page stays
    expect(screen.getByRole('link', { name: /^Τηλεφώνησε/ })).toHaveAttribute(
      'href',
      'tel:+302610000000',
    )
    screen.getByRole('button', { name: 'Δοκίμασε ξανά' }).click()
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
