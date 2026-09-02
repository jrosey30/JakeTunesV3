import { useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import { setNotice } from '../../activity'
import '../../styles/queue.css'

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const mins = Math.floor(totalSecs / 60)
  const secs = totalSecs % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export type QueuePanelHandle = { requestClose: () => void }

const QueuePanel = forwardRef<QueuePanelHandle, { onClose: () => void }>(function QueuePanel({ onClose }, ref) {
  const { state, dispatch } = usePlayback()
  const { state: libState } = useLibrary()
  const { playTrack } = useAudio()
  const upcoming = state.queue.slice(state.queueIndex + 1)
  // Repeat state drives honest "Up Next" representation: under repeat one
  // the natural-end handler replays the current track (it never advances),
  // and under repeat all the queue loops back to index 0 after the tail.
  // The visible list must say so or it's lying about what plays next.
  const repeatOne = state.repeat === 'one'
  const repeatAll = state.repeat === 'all'
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [exiting, setExiting] = useState(false)

  const requestClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    window.setTimeout(() => onClose(), 220)
  }, [exiting, onClose])

  useImperativeHandle(ref, () => ({ requestClose }), [requestClose])

  // Mirror TransportControls.cycleRepeat so the queue panel can both
  // SHOW and CHANGE repeat state — parity with the shuffle toggle that
  // already lives in this header.
  const cycleRepeat = useCallback(() => {
    const modes = ['off', 'all', 'one'] as const
    const idx = modes.indexOf(state.repeat)
    dispatch({ type: 'SET_REPEAT', mode: modes[(idx + 1) % 3] })
  }, [state.repeat, dispatch])

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
      playTrack(tracks[0], newQueue, startIndex, undefined, true)
      setDropIndex(null)
      return
    }

    // Player is active (playing or paused) — queue without interrupting.
    // Queue honesty (2026-09-02): SAY where it landed. "End of queue" on a
    // whole-library queue is thousands of songs away, and that used to be
    // silent.
    const noun = tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`
    if (dropIndex !== null) {
      const absIndex = state.queueIndex + 1 + dropIndex
      dispatch({ type: 'INSERT_IN_QUEUE', tracks, atIndex: absIndex })
      setNotice(dropIndex === 0 ? `Playing next: ${noun}` : `Up Next: ${noun} — ${dropIndex} song${dropIndex === 1 ? '' : 's'} from now`, { kind: 'success' })
    } else {
      dispatch({ type: 'ADD_TO_QUEUE', tracks })
      const away = state.queue.length - state.queueIndex - 1
      setNotice(`Added to the END of Up Next: ${noun} — ${away.toLocaleString()} song${away === 1 ? '' : 's'} from now. Drop on Now Playing to play it next.`, { kind: away > 25 ? 'info' : 'success', durationMs: away > 25 ? 6000 : 3500 })
    }
    setDropIndex(null)
  }, [resolveTracks, dropIndex, state.queueIndex, state.queue, state.nowPlaying, dispatch, playTrack])

  /** Dropping on the Now Playing block means "play this next" → slot 0. */
  const handleNowPlayingDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropIndex(0)
  }, [])

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    // Anything that reaches HERE is not over a row and not over Now Playing —
    // both of those stopPropagation — so it means "end of queue".
    //
    // This used to additionally require the target to be the panel itself,
    // `.queue-list`, or `.queue-empty`. Every other pixel (section labels, the
    // repeat note, padding, the gap under the last row) therefore left
    // dropIndex untouched: no indicator, and a drop that either did nothing or
    // silently used a stale position from wherever the cursor had last been.
    // A panel that shows no indicator while still accepting the drop is the
    // dishonest part — you cannot tell a dead zone from a working one.
    setDropIndex(upcoming.length)
  }, [upcoming.length])

  return (
    <div
      className={`queue-panel${exiting ? ' queue-panel--exiting' : ''}`}
      onDragOver={handlePanelDragOver}
      onDragLeave={(e) => {
        // dragleave fires when crossing INTO a child row too — only clear the
        // drop indicator when the drag actually leaves the panel, or the drop
        // position flickers away mid-aim and the drop lands at the end.
        const next = e.relatedTarget as Node | null
        if (!next || !(e.currentTarget as HTMLElement).contains(next)) setDropIndex(null)
      }}
      onDrop={handleDrop}
    >
      <div className="queue-header">
        <span className="queue-title">Up Next</span>
        <button
          className={`queue-repeat ${state.repeat !== 'off' ? 'queue-repeat--active' : ''}`}
          title={
            state.repeat === 'one' ? 'Repeat One — current track replays (click to turn off)'
            : state.repeat === 'all' ? 'Repeat All — queue loops (click for Repeat One)'
            : 'Repeat is OFF — click to loop the queue'
          }
          onClick={cycleRepeat}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h7a3 3 0 0 1 3 3" />
            <path d="M12 2.5L14.5 5 12 7.5" />
            <path d="M12 11H5a3 3 0 0 1-3-3" />
            <path d="M4 13.5L1.5 11 4 8.5" />
          </svg>
          {state.repeat === 'one' && <span className="queue-repeat-badge">1</span>}
        </button>
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
        <button className="queue-close" onClick={requestClose}>&times;</button>
      </div>
      {/* The Now Playing block is a DROP TARGET meaning "play this next".
          It used to have no drag handlers at all, so dropping on it — the
          natural gesture for "I want this next" — showed no drop indicator
          and silently did nothing. Reordering worked only if you happened to
          land on one of the Up Next rows; aim an inch higher and the drag
          died with no feedback. Mapping it to dropIndex 0 puts the indicator
          at the top of Up Next, which is exactly where the track will land. */}
      {state.nowPlaying && (
        <div
          className="queue-section"
          onDragOver={handleNowPlayingDragOver}
        >
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
          {repeatOne && state.nowPlaying && (
            <div className="queue-repeat-note">↻ Repeat One — “{state.nowPlaying.title}” keeps replaying until you skip.</div>
          )}
          {upcoming.length === 0 && dropIndex === null && state.repeat === 'off' && (
            <div className="queue-empty">No upcoming tracks</div>
          )}
          {dropIndex === 0 && <div className="queue-drop-indicator" />}
          {/* freshContext=false: this track is already IN the queue, so a
              double-click is queue NAVIGATION (jump to it in the current
              order), NOT a fresh play context. Passing true here made the
              shuffle reducer rebuild the queue from scratch, scrambling
              the very list the user was looking at. */}
          {upcoming.slice(0, 100).map((track, i) => (
            <div key={`${track.id}-${i}`}>
              <div
                className="queue-item"
                draggable
                onDragStart={(e) => handleItemDragStart(e, i)}
                onDoubleClick={() => playTrack(track, state.queue, state.queueIndex + 1 + i, undefined, false)}
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
          {repeatAll && state.queue.length > 0 && (
            <div className="queue-repeat-note queue-repeat-note--loop">↻ Repeat All — loops back to the top after the last track.</div>
          )}
        </div>
      </div>
    </div>
  )
})

export default QueuePanel
