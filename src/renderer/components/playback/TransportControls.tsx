import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import PlayIcon from '../../assets/icons/PlayIcon'
import PauseIcon from '../../assets/icons/PauseIcon'
import PrevIcon from '../../assets/icons/PrevIcon'
import NextIcon from '../../assets/icons/NextIcon'
import RepeatIcon from '../../assets/icons/RepeatIcon'
import ShuffleIcon from '../../assets/icons/ShuffleIcon'
import type { RepeatMode } from '../../types'

export default function TransportControls() {
  const { state, dispatch } = usePlayback()
  const { togglePlayPause, nextTrack, prevTrack } = useAudio()

  const cycleRepeat = () => {
    const modes: RepeatMode[] = ['off', 'all', 'one']
    const idx = modes.indexOf(state.repeat)
    dispatch({ type: 'SET_REPEAT', mode: modes[(idx + 1) % 3] })
  }

  return (
    <div className="transport-controls">
      <div className="transport-main">
        <button className="transport-btn" onClick={prevTrack} title="Previous">
          <PrevIcon size={18} />
        </button>
        <button className="transport-btn transport-btn--play" onClick={togglePlayPause} title={state.isPlaying ? 'Pause' : 'Play'}>
          {state.isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        <button className="transport-btn" onClick={nextTrack} title="Next">
          <NextIcon size={18} />
        </button>
      </div>
      <div className="transport-modes">
        <button className={`transport-toggle ${state.repeat !== 'off' ? 'transport-toggle--active' : ''}`} onClick={cycleRepeat} title={`Repeat: ${state.repeat}`}>
          <RepeatIcon active={state.repeat !== 'off'} one={state.repeat === 'one'} />
        </button>
        <button className={`transport-toggle ${state.shuffle ? 'transport-toggle--active' : ''}`} onClick={() => dispatch({ type: 'TOGGLE_SHUFFLE' })} title="Shuffle">
          <ShuffleIcon active={state.shuffle} />
        </button>
      </div>
    </div>
  )
}
