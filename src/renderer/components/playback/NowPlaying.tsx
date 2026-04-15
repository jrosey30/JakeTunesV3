import { useCallback, useRef } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'

function formatTime(s: number): string {
  if (!s || s < 0) return '0:00'
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function NowPlaying() {
  const { state } = usePlayback()
  const { seek } = useAudio()
  const barRef = useRef<HTMLDivElement>(null)

  const getPercent = useCallback((clientX: number) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (state.duration <= 0) return
    seek(getPercent(e.clientX))

    const onMove = (ev: MouseEvent) => seek(getPercent(ev.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [seek, state.duration, getPercent])

  const progress = state.duration > 0 ? (state.position / state.duration) * 100 : 0
  const track = state.nowPlaying

  return (
    <div className="now-playing-pill">
      {track ? (
        <>
          <div className="now-playing-info">
            <span className="now-playing-title">{track.title}</span>
            <span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{track.artist}</span>
            {track.album && <span className="now-playing-sep"> — </span>}
            {track.album && <span className="now-playing-album">{track.album}</span>}
          </div>
          <div className="scrubber-row">
            <span className="scrubber-time">{formatTime(state.position)}</span>
            <div className="scrubber-track" ref={barRef} onMouseDown={handleMouseDown}>
              <div className="scrubber-fill" style={{ width: `${progress}%` }} />
              <div className="scrubber-knob" style={{ left: `${progress}%` }} />
            </div>
            <span className="scrubber-time">-{formatTime(state.duration - state.position)}</span>
          </div>
        </>
      ) : (
        <div className="now-playing-empty" />
      )}
    </div>
  )
}
