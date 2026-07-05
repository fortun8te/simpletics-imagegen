// ErrorBoundary — classic class component (componentDidCatch is only available on class
// components; there is no hooks equivalent). Catches render/lifecycle exceptions in its subtree
// so a single bad render doesn't blank the whole app. Shows a compact panel: the error message,
// a Reload button, and a Copy error button (clipboard) — themed with tokens from theme.css so it
// looks native in both the light and dark palettes.
//
// Usage: wrap the app root in main.tsx (catches everything) and wrap the Design view region
// separately wherever that mounts, so a canvas/render crash in Design mode doesn't take the
// sidebar/topbar down with it. See ERR-1 in the resilience audit.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown in the panel heading, e.g. "Design view" — helps distinguish which
   *  boundary tripped when more than one is mounted. */
  label?: string;
  /** Optional custom fallback renderer — if omitted, the default compact panel is used. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  copyError = () => {
    const { error } = this.state;
    if (!error) return;
    const text = `${error.name}: ${error.message}\n${error.stack || ''}`;
    navigator.clipboard?.writeText(text).catch(() => { /* clipboard unavailable — no-op */ });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3, 12px)',
          maxWidth: 480,
          margin: 'var(--space-8, 32px) auto',
          padding: 'var(--space-5, 20px)',
          background: 'var(--surface-2, #222)',
          border: '1px solid var(--line, rgba(255,255,255,0.08))',
          borderRadius: 'var(--r-lg, 12px)',
          boxShadow: 'var(--shadow-md, none)',
          color: 'var(--ink, #eee)',
          font: '400 14px var(--font-sans, sans-serif)',
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>
          {this.props.label ? `Something broke in ${this.props.label}` : 'Something broke'}
        </p>
        <p
          style={{
            margin: 0,
            padding: 'var(--space-3, 12px)',
            background: 'var(--err-soft, rgba(220,50,50,0.12))',
            color: 'var(--err, #e55)',
            borderRadius: 'var(--r-md, 10px)',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 160,
            overflow: 'auto',
          }}
        >
          {error.message || String(error)}
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2, 8px)' }}>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-md, 10px)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              background: 'var(--accent, #4c8dff)',
              color: 'var(--ink, #fff)',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.copyError}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-md, 10px)',
              border: '1px solid var(--line, rgba(255,255,255,0.08))',
              background: 'var(--surface-3, transparent)',
              color: 'var(--ink, #eee)',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Copy error
          </button>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: '8px 14px',
              borderRadius: 'var(--r-md, 10px)',
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--muted, #888)',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
