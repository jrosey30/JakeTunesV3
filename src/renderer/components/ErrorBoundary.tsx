import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * Last-resort render safety net. Without this, any throw in the React tree
 * greys the whole window with no recovery path (CLAUDE.md assumes an
 * error boundary). Reloads the renderer — library state lives in main /
 * electron-store, so a reload is safe.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          margin: 0,
          padding: '32px',
          boxSizing: 'border-box',
          background: 'var(--bg-primary, #f5f0e8)',
          color: 'var(--text-primary, #2a2a2a)',
          fontFamily: 'var(--font-ui, system-ui, sans-serif)',
          textAlign: 'center',
          WebkitAppRegion: 'drag',
        } as CSSProperties}
      >
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--brand-orange, #bb4308)', marginBottom: 12 }}>
          JakeTunes
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 600 }}>
          Something went wrong
        </h1>
        <p style={{ margin: '0 0 20px', maxWidth: 360, fontSize: 13, lineHeight: 1.45, color: 'var(--text-secondary, #666)' }}>
          The window hit an unexpected error. Your library is fine — reload to continue.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            WebkitAppRegion: 'no-drag',
            border: '1px solid var(--brand-orange-border, #7f2803)',
            borderRadius: 4,
            padding: '8px 18px',
            background: 'linear-gradient(180deg, var(--brand-orange-light, #d6601f), var(--brand-orange, #bb4308))',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          } as CSSProperties}
        >
          Reload
        </button>
      </div>
    )
  }
}
