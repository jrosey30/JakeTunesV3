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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const tracks = resolveTracks(e)
    if (tracks.length === 0) return

    if (dropIndex !== null) {
      // Insert at specific position in the queue (absolute index)
      const absIndex = state.queueIndex + 1 + dropIndex
      dispatch({ type: 'INSERT_IN_QUEUE', tracks, atIndex: absIndex })
    } else {
      dispatch({ type: 'ADD_TO_QUEUE', tracks })
    }
    setDropIndex(null)
  }, [resolveTracks, dropIndex, state.queueIndex, dispatch])

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
          className="queue-shuffle"
          title="Shuffle Up Next"
          onClick={() => dispatch({ type: 'SHUFFLE_QUEUE' })}
          disabled={upcoming.length < 2}
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
