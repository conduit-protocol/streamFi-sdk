import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown instead of the crashed subtree. Receives the error and a reset fn. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Human label used in the default fallback copy, e.g. "Transaction History". */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Defence in depth for #136 / #103.
 *
 * The undefined-state crash itself is fixed at the source (see
 * `src/dashboard/transaction-history.ts` and `useTransactionHistory`), but a
 * render-time throw anywhere in a child previously unmounted the *entire*
 * React tree, leaving the user with a blank page. Wrapping the panel in a
 * boundary keeps the rest of the dashboard interactive and gives the user a
 * way to recover in place, which is the "handle this gracefully without
 * breaking the user experience" requirement from the issue.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // Replace with your telemetry sink (Sentry, etc.) in a real app.
    console.error(
      `[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`,
      error,
      info.componentStack,
    );
  }

  private reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div role="alert" style={{ padding: '1.5rem' }}>
        <p style={{ fontWeight: 600, margin: '0 0 0.25rem' }}>
          {this.props.label ?? 'This section'} couldn’t be displayed.
        </p>
        <p style={{ margin: '0 0 0.75rem', color: '#4b5563' }}>{error.message}</p>
        <button type="button" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}
