/**
 * The renderer crash net (2026-08-21, reliability program P0).
 *
 * Before this, a renderer death was a GREY SCREEN with no trace: no error
 * boundary, no window.onerror, nothing durable. CLAUDE.md documents the TDZ
 * grey-screen class from experience — this file makes every future one
 * (1) recorded in main.log via the flight recorder, and (2) recoverable in
 * place with a reload button instead of a dead window.
 *
 * Three nets, because React boundaries alone miss most of reality:
 *  - ErrorBoundary  → render-phase throws (the grey-screen class)
 *  - window.onerror → event handlers, timers, third-party code
 *  - unhandledrejection → every fire-and-forget promise that broke quietly
 */
import React from 'react'

function report(kind: string, message: string, stack?: string, source?: string): void {
  try {
    window.electronAPI?.reportCrash?.({ kind, message, stack, source })
  } catch { /* the net must never itself throw */ }
}

let globalNetsArmed = false
export function armGlobalNets(): void {
  if (globalNetsArmed) return
  globalNetsArmed = true
  window.addEventListener('error', (e) => {
    report('window-error', String(e.message || ''), e.error instanceof Error ? e.error.stack : undefined, `${e.filename || ''}:${e.lineno || 0}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    report('unhandled-rejection', r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined)
  })
  report('boot.renderer-mounted', '')
}

interface State { crashed: boolean; message: string }

export class CrashNet extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { crashed: false, message: '' }

  static getDerivedStateFromError(err: unknown): State {
    return { crashed: true, message: err instanceof Error ? err.message : String(err) }
  }

  componentDidCatch(err: unknown, info: React.ErrorInfo): void {
    report('render-crash', err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.stack : undefined, info.componentStack?.split('\n')[1]?.trim())
  }

  render(): React.ReactNode {
    if (!this.state.crashed) return this.props.children
    // Inline styles on purpose: a render crash may mean the stylesheet
    // pipeline itself is the casualty. This panel must need nothing.
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f2ed', fontFamily: 'system-ui' }}>
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1a1a1a', marginBottom: 6 }}>JakeTunes hit a wall.</div>
          <div style={{ fontSize: 12, color: '#8a8275', marginBottom: 14 }}>
            The crash is recorded in the flight log. Your library is untouched.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '8px 18px', borderRadius: 6, border: '1px solid #d0c8b8', background: '#fc5501', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
