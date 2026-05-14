import { useState, useCallback } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import '../../styles/queue.css'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function QueuePanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = usePlayback()
  const { state: libState } = useLibrary()
  const { playTrack } = useAudio()
  const upcoming = state.queue.slice(state.queueIndex + 1)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const resolveTracks = useCallback((e: React.DragEvent) => {
    const data = e.dataTransfer.getData('application/jaketunes-tracks')
    if (!data) return []
    const ids: number[] = JSON.parse(data)
    return ids.map(id => libState.tracks.find(t => t.id === id)).filter(Boolean) as typeof libState.tracks
  }, [libState.tracks])

  const handleItemDragOver = useCallback((e: React.DragEvent, i: number) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    // Drop above or below based on mouse position
    setDropIndex(e.clientY < midY ? i : i + 1)
  }, [])

  const handleItemDragStart = useCallback((e: React.DragEvent, i: number) => {
    // Intra-queue reorder. `i` is the index within `upcoming`; convert
    // to the absolute queue index (skip past current + earlier).
    const absIndex = state.queueIndex + 1 + i
    e.dataTransfer.setData('application/jaketunes-queue-reorder', String(absIndex))
    e.dataTransfer.effectAllowed = 'move'
  }, [state.queueIndex])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    // Reorder branch: a queue item was the drag source. Take precedence
    // over the library-track import branch — the user is rearranging
    // existing queue items, not adding new ones.
    const reorderRaw = e.dataTransfer.getData('application/jaketunes-queue-reorder')
    if (reorderRaw) {
      const fromIndex = parseInt(reorderRaw, 10)
      if (Number.isFinite(fromIndex) && dropIndex !== null) {
        const toIndex = state.queueIndex + 1 + dropIndex
        dispatch({ type: 'MOVE_IN_QUEUE', fromIndex, toIndex })
      }
      setDropIndex(null)
      return
    }
    // Library-track import branch.
    const tracks = resolveTracks(e)
    if (tracks.length === 0) {
      setDropIndex(null)
      return
    }

    // 4.4.45 — "honest queue." If the player is idle (nothing loaded —
    // fresh launch, cleared queue, or the queue finished and the
    // natural-end handler dispatched STOP, which nulls nowPlaying), a
    // track dragged into the queue should START PLAYING — not just land
    // silently in the list. That's the bug Jake hit: "if i drag
    // something into queue, it does not play."
    //
    // Root cause: ADD_TO_QUEUE / INSERT_IN_QUEUE only mutate the queue
    // array — they never touch nowPlaying / isPlaying / queueIndex. And
    // the audio engine is imperative: only playTrack() / loadAndPlay()
    // actually produce sound (the reducer can't call into the audio
    // engine). So when idle we build the would-be queue locally and
    // hand it straight to playTrack(), which does the
    // dispatch(PLAY_TRACK) + loadAndPlay() in one call.
    //
    // "Idle" = !nowPlaying. That's the unambiguous "player has nothing
    // loaded" state — it does NOT fire when something's actively
    // playing OR paused (both keep nowPlaying set), so a drag never
    // interrupts a track in progress; it just queues normally.
    if (!state.nowPlaying) {
      let newQueue: typeof tracks
      let startIndex: number
      if (dropIndex !== null) {
        const absIndex = Math.max(0, state.queueIndex + 1 + dropIndex)
        newQueue = [...state.queue]
        newQueue.splice(absIndex, 0, ...tracks)
        startIndex = absIndex
      } else {
        newQueue = [...state.queue, ...tracks]
        startIndex = state.queue.length
      }
      playTrack(tracks[0], newQueue, startIndex)
      setDropIndex(null)
      return
    }

    // Player is active (playing or paused) — queue without interrupting.
    if (dropIndex !== null) {
      const absIndex = state.queueIndex + 1 + dropIndex
      dispatch({ type: 'INSERT_IN_QUEUE', tracks, atIndex: absIndex })
    } else {
      dispatch({ type: 'ADD_TO_QUEUE', tracks })
    }
    setDropIndex(null)
  }, [resolveTracks, dropIndex, state.queueIndex, state.queue, state.nowPlaying, dispatch, playTrack])

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    // Only set drop at end if not over a specific item
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('queue-list') || (e.target as HTMLElement).classList.contains('queue-empty')) {
      setDropIndex(upcoming.length)
    }
  }, [upcoming.length])

  return (
    <div
      className="queue-panel"
      onDragOver={handlePanelDragOver}
      onDragLeave={() => setDropIndex(null)}
      onDrop={handleDrop}
    >
      <div className="queue-header">
        <span className="queue-title">Up Next</span>
        <button
          className={`queue-shuffle ${state.shuffle ? 'queue-shuffle--active' : ''}`}
          title={state.shuffle ? 'Shuffle is ON — click to turn off' : 'Shuffle is OFF — click to turn on'}
          onClick={() => dispatch({ type: 'TOGGLE_SHUFFLE' })}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4h3l3 8h3" />
            <path d="M1 12h3l3-8h3" />
            <path d="M12 2l3 2-3 2" />
            <path d="M12 10l3 2-3 2" />
            <path d="M15 4h-5" />
            <path d="M15 12h-5" />
          </svg>
        </button>
        <button className="queue-clear" onClick={() => dispatch({ type: 'CLEAR_QUEUE' })}>Clear</button>
        <button className="queue-close" onClick={onClose}>&times;</button>
      </div>
      {state.nowPlaying && (
        <div className="queue-section">
          <div className="queue-section-label">Now Playing</div>
          <div className="queue-item queue-item--playing">
            <div className="queue-item-title">{state.nowPlaying.title}</div>
            <div className="queue-item-artist">{state.nowPlaying.artist}{state.nowPlaying.album ? ` — ${state.nowPlaying.album}` : ''}</div>
            <div className="queue-item-time">{formatDuration(state.nowPlaying.duration)}</div>
          </div>
        </div>
      )}
      <div className="queue-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="queue-section-label">Up Next ({upcoming.length})</div>
        <div className="queue-list" style={{ flex: 1, overflowY: 'auto' }}>
          {upcoming.length === 0 && dropIndex === null && (
            <div className="queue-empty">No upcoming tracks</div>
          )}
          {dropIndex === 0 && <div className="queue-drop-indicator" />}
          {upcoming.slice(0, 100).map((track, i) => (
            <div key={`${track.id}-${i}`}>
              <div
                className="queue-item"
                draggable
                onDragStart={(e) => handleItemDragStart(e, i)}
                onDoubleClick={() => playTrack(track, state.queue, state.queueIndex + 1 + i)}
                onDragOver={(e) => handleItemDragOver(e, i)}
              >
                <div className="queue-item-num">{i + 1}</div>
                <div className="queue-item-info">
                  <div className="queue-item-title">{track.title}</div>
                  <div className="queue-item-artist">{track.artist}{track.album ? ` — ${track.album}` : ''}</div>
                </div>
                <div className="queue-item-time">{formatDuration(track.duration)}</div>
                <button
                  className="queue-item-remove"
                  title="Remove"
                  onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REMOVE_FROM_QUEUE', index: state.queueIndex + 1 + i }) }}
                >
                  &times;
                </button>
              </div>
              {dropIndex === i + 1 && <div className="queue-drop-indicator" />}
            </div>
          ))}
          {upcoming.length === 0 && dropIndex !== null && (
            <div className="queue-drop-indicator" />
          )}
        </div>
      </div>
    </div>
  )
}
