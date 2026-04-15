import { useCallback, useRef } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { SpeakerMuteIcon, SpeakerLowIcon, SpeakerHighIcon } from '../../assets/icons/SpeakerIcon'

export default function VolumeSlider() {
  const { state } = usePlayback()
  const { setVolume } = useAudio()
  const trackRef = useRef<HTMLDivElement>(null)

  const getPercent = useCallback((clientX: number) => {
    if (!trackRef.current) return 0
    const rect = trackRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setVolume(getPercent(e.clientX))

    const onMove = (ev: MouseEvent) => setVolume(getPercent(ev.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [setVolume, getPercent])

  const SpeakerLeft = state.volume === 0 ? SpeakerMuteIcon : SpeakerLowIcon

  // Keep knob fully within slider bounds (7px = half knob width)
  const pct = state.volume * 100
  const knobOffset = 7 - state.volume * 14
  const knobLeft = `calc(${pct}% + ${knobOffset}px)`

  return (
    <div className="volume-control">
      <button className="volume-icon" onClick={() => setVolume(0)} title="Mute">
        <SpeakerLeft />
      </button>
      <div className="volume-slider-wrap" ref={trackRef} onMouseDown={handleMouseDown}>
        <div className="volume-track">
          <div className="volume-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="volume-knob" style={{ left: knobLeft }} />
      </div>
      <button className="volume-icon" onClick={() => setVolume(1)} title="Max Volume">
        <SpeakerHighIcon />
      </button>
    </div>
  )
}
