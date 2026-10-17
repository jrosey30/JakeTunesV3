import { useSyncExternalStore } from 'react'
import { dismissToast, getSnapshot, getToast, subscribe } from '../state/recentlyAdded'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { playOrderForImport } from '../../common/import-toast'
import type { Track } from '../types'
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

  // "Added to your library" is a door: click it to play what just landed.
  // Only that toast mounts the library/playback hooks — the app-wide host
  // stays a cheap null the rest of the time.
  if (toast.kind === 'success' && toast.trackIds.length > 0) {
    return <PlayableSuccessToast message={toast.message} trackIds={toast.trackIds} />
  }

  const isFailure = toast.kind === 'failure'
  const message = toast.kind === 'failure'
    ? `Couldn't import '${toast.filename}' — ${toast.error}`
    : toast.message

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

function PlayableSuccessToast({ message, trackIds }: { message: string; trackIds: number[] }) {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()

  const play = () => {
    const byId = new Map(lib.tracks.map((t) => [t.id, t]))
    const landed = trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t)
    const queue = playOrderForImport(landed)
    if (queue.length) playTrack(queue[0], queue, 0, undefined, true)
    dismissToast()
  }

  return (
    <div className="undo-toast bandcamp-import-toast" role="status" onClick={play} title="Click to play">
      <span className="undo-toast-message">{message}</span>
    </div>
  )
}
