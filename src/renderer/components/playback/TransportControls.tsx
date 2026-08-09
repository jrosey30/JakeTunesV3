import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import PlayIcon from '../../assets/icons/PlayIcon'
import PauseIcon from '../../assets/icons/PauseIcon'
import PrevIcon from '../../assets/icons/PrevIcon'
import NextIcon from '../../assets/icons/NextIcon'
import RepeatIcon from '../../assets/icons/RepeatIcon'
import ShuffleIcon from '../../assets/icons/ShuffleIcon'
import { subscribeMixtapes, getTapeSession } from '../../mixtapes'
import { useSyncExternalStore } from 'react'
import type { RepeatMode } from '../../types'

export default function TransportControls() {
  const { state, dispatch } = usePlayback()
  const { togglePlayPause, nextTrack, prevTrack } = useAudio()
  // NO SKIPPING ON A TAPE (Jake, 2026-08-08: "you cant skip"). While a tape
  // is running, prev/next and shuffle are dead — a tape plays start to
  // finish. Disabled rather than silently ignored so the reason is visible
  // in the UI instead of feeling like a broken button. Play/pause stays:
  // stopping the tape is allowed, jumping around inside it is not.
  useSyncExternalStore(subscribeMixtapes, getTapeSession)
  const onTape = !!getTapeSession()

  const cycleRepeat = () => {
    const modes: RepeatMode[] = ['off', 'all', 'one']
    const idx = modes.indexOf(state.repeat)
    dispatch({ type: 'SET_REPEAT', mode: modes[(idx + 1) % 3] })
  }

  return (
    <div className="transport-controls">
      <div className="transport-main">
        <button className="transport-btn" onClick={prevTrack} disabled={onTape}
          title={onTape ? 'A tape plays start to finish — no skipping' : 'Previous'}>
          <PrevIcon size={18} />
        </button>
        <button className="transport-btn transport-btn--play" onClick={togglePlayPause} title={state.isPlaying ? 'Pause' : 'Play'}>
          {state.isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        <button className="transport-btn" onClick={nextTrack} disabled={onTape}
          title={onTape ? 'A tape plays start to finish — no skipping' : 'Next'}>
          <NextIcon size={18} />
        </button>
      </div>
      <div className="transport-modes">
        <button className={`transport-toggle ${state.repeat !== 'off' ? 'transport-toggle--active' : ''}`} onClick={cycleRepeat} title={`Repeat: ${state.repeat}`}>
          <RepeatIcon active={state.repeat !== 'off'} one={state.repeat === 'one'} />
        </button>
        <button className={`transport-toggle ${state.shuffle ? 'transport-toggle--active' : ''}`} disabled={onTape}
          onClick={() => dispatch({ type: 'TOGGLE_SHUFFLE' })}
          title={onTape ? 'Not on a tape — it plays in order' : 'Shuffle'}>
          <ShuffleIcon active={state.shuffle} />
        </button>
      </div>
    </div>
  )
}
