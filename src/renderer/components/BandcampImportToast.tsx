import { useSyncExternalStore } from 'react'
import { dismissToast, getSnapshot, getToast, subscribe } from '../state/recentlyAdded'
import '../styles/toast.css'

// Reuses .undo-toast styling (toast.css) for layout + slide-in/slide-out
// animations, then overrides background / accent for the Bandcamp variant.
// One toast at a time — the recentlyAdded store replaces (not queues) on
// each new aggregated burst.

export default function BandcampImportToast() {
  const _ = useSyncExternalStore(subscribe, getSnapshot)
  void _
  const toast = getToast()
  if (!toast) return null

  const isFailure = toast.kind === 'failure'
  const message = toast.kind === 'success'
    ? toast.message
    : `Couldn't import '${toast.filename}' — ${toast.error}`

  return (
    <div
      className={`undo-toast bandcamp-import-toast${isFailure ? ' bandcamp-import-toast--failure' : ''}`}
      role="status"
      onClick={dismissToast}
      title="Click to dismiss"
    >
      <span className="undo-toast-message">{message}</span>
    </div>
  )
}
