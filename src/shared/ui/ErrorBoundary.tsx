import { Component, type ReactNode } from 'react'

type Props = {
  /** What shows instead of the children once one of them threw while rendering. */
  fallback: ReactNode
  children: ReactNode
}

type State = { failed: boolean }

/**
 * Catches an error thrown while rendering below it, typically a lazy chunk that did not load
 * (flaky network, or a page opened before a deploy whose old chunk is gone), so the page shows
 * `fallback` instead of going blank. React.lazy remembers a failed load, so the way out is a
 * reload, which the fallback offers (see `LoadFailed` of the booking page).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
