import { useRef, useEffect, useCallback } from 'react'
import { Howl } from 'howler'
import { usePlayback } from '../context/PlaybackContext'
import { useLibrary } from '../context/LibraryContext'
import { Track } from '../types'

// Resolved at runtime from main process via IPC — set by init call
let IPOD_MOUNT = ''
window.electronAPI?.getMusicLibraryPath?.().then((p: string) => { IPOD_MOUNT = p }).catch(() => {})

const FORMAT_MAP: Record<string, string> = {
  '.mp3': 'mp3', '.m4a': 'mp4', '.m4p': 'mp4', '.aac': 'aac',
  '.wav': 'wav', '.wave': 'wav', '.aif': 'aiff', '.aiff': 'aiff',
  '.flac': 'flac', '.ogg': 'ogg', '.oga': 'ogg', '.wma': 'wma', '.alac': 'mp4',
}

function ipodPathToAudioURL(ipodPath: string): { url: string; format: string } {
  const fsPath = IPOD_MOUNT + ipodPath.replace(/:/g, '/')
  const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase()
  const format = FORMAT_MAP[ext] || 'mp3'
  const url = 'ipod-audio://' + encodeURIComponent(fsPath)
  return { url, format }
}

// Module-level singleton so all components share the same Howl
let sharedHowl: Howl | null = null
let sharedRaf = 0
let isPaused = false
let autoDjMode = false
export function setAutoDjMode(on: boolean) {
  console.log('[Audio] autoDjMode:', on)
  autoDjMode = on
}
export function getAutoDjMode() { return autoDjMode }

// ── Crossfade (4.0 §6.7) ──
// During an active crossfade the OUTGOING howl plays alongside the new
// `sharedHowl`. Volumes are interpolated in updatePosition each rAF
// tick. When the fade completes (or any user action disrupts it),
// outgoingHowl is unloaded.
let crossfadeSettings = { enabled: false, seconds: 6 }
let outgoingHowl: Howl | null = null
let crossfading = false
let crossfadeStartedAtMs = 0
export function setCrossfadeSettings(s: { enabled: boolean; seconds: number }) {
  crossfadeSettings = { enabled: !!s.enabled, seconds: Math.max(1, Math.min(12, s.seconds || 6)) }
}
function cleanupCrossfadeAudio() {
  if (outgoingHowl) {
    try { outgoingHowl.stop() } catch { /* ignore */ }
    try { outgoingHowl.unload() } catch { /* ignore */ }
    outgoingHowl = null
  }
  crossfading = false
}


export function useAudio() {
  const { state, dispatch } = usePlayback()
  const { state: libState, dispatch: libDispatch } = useLibrary()
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const stateRef = useRef(state)
  stateRef.current = state
  const libDispatchRef = useRef(libDispatch)
  libDispatchRef.current = libDispatch
  const tracksRef = useRef(libState.tracks)
  tracksRef.current = libState.tracks

  // Held by ref so updatePosition can call it without making
  // updatePosition reference loadAndPlay (which references updatePosition).
  const startCrossfadeRef = useRef<((track: Track, queue: Track[], queueIndex: number) => void) | null>(null)

  const updatePosition = useCallback(() => {
    if (isPaused || !sharedHowl || !sharedHowl.playing()) return
    const pos = sharedHowl.seek() as number
    dispatchRef.current({ type: 'SET_POSITION', position: pos })
    const dur = sharedHowl.duration()
    if (dur > 0) {
      dispatchRef.current({ type: 'SET_DURATION', duration: dur })
    }

    // Crossfade volume animation. Runs alongside normal position updates.
    if (crossfading && outgoingHowl && sharedHowl) {
      const fadeMs = crossfadeSettings.seconds * 1000
      const elapsedMs = Date.now() - crossfadeStartedAtMs
      const progress = Math.max(0, Math.min(1, elapsedMs / fadeMs))
      const targetVol = stateRef.current.volume
      try { outgoingHowl.volume(targetVol * (1 - progress)) } catch { /* ignore */ }
      try { sharedHowl.volume(targetVol * progress) } catch { /* ignore */ }
      if (progress >= 1) {
        cleanupCrossfadeAudio()
      }
    }

    // Crossfade trigger: when the current track has crossfadeSeconds left,
    // pre-load the next track and begin the fade. Bypassed when DJ Mode
    // is active (DJ Mode runs its own transitions), when repeat=one, or
    // when there is no next track. Tracks shorter than the fade duration
    // get a no-fade natural end.
    if (
      crossfadeSettings.enabled &&
      !crossfading &&
      !autoDjMode &&
      sharedHowl &&
      dur > crossfadeSettings.seconds + 1
    ) {
      const remaining = dur - pos
      if (remaining > 0 && remaining <= crossfadeSettings.seconds) {
        const s = stateRef.current
        if (s.repeat !== 'one' && s.queue.length > 0) {
          let nextIdx: number
          if (s.shuffle) {
            nextIdx = Math.floor(Math.random() * s.queue.length)
            if (s.queue.length > 1 && nextIdx === s.queueIndex) {
              nextIdx = (nextIdx + 1) % s.queue.length
            }
          } else {
            nextIdx = s.queueIndex + 1
            if (nextIdx >= s.queue.length) {
              nextIdx = s.repeat === 'all' ? 0 : -1
            }
          }
          if (nextIdx >= 0) {
            const nextTrack = s.queue[nextIdx]
            if (nextTrack) {
              dispatchRef.current({ type: 'PLAY_TRACK', track: nextTrack, queue: s.queue, queueIndex: nextIdx })
              startCrossfadeRef.current?.(nextTrack, s.queue, nextIdx)
            }
          }
        }
      }
    }

    sharedRaf = requestAnimationFrame(updatePosition)
  }, [])

  const loadAndPlay = useCallback((track: Track, queue: Track[], queueIndex: number, asCrossfade: boolean = false) => {
    isPaused = false
    if (asCrossfade && sharedHowl) {
      // Hand off the current Howl to outgoing for the fade. Don't unload
      // it yet — updatePosition will fade it to silence then clean up.
      // Any prior outgoing (rare — only if a previous crossfade hadn't
      // finished) is silenced cleanly first.
      cleanupCrossfadeAudio()
      outgoingHowl = sharedHowl
      crossfading = true
      crossfadeStartedAtMs = Date.now()
    } else {
      cleanupCrossfadeAudio()
      if (sharedHowl) {
        sharedHowl.unload()
        sharedHowl = null
      }
    }
    cancelAnimationFrame(sharedRaf)

    const { url, format } = ipodPathToAudioURL(track.path || '')
    // Guard against the Howler 'end' event firing twice for the same
    // playback, which would cause the same track to auto-play again
    // even with repeat off. Also belt-and-suspenders loop:false so no
    // underlying <audio> element ever auto-loops.
    let ended = false
    const startVolume = asCrossfade ? 0 : stateRef.current.volume
    const howl = new Howl({
      src: [url],
      format: [format],
      html5: true,
      loop: false,
      volume: startVolume,
      onplay: () => {
        dispatchRef.current({ type: 'SET_DURATION', duration: howl.duration() })
        sharedRaf = requestAnimationFrame(updatePosition)
      },
      onend: () => {
        if (ended) return
        ended = true
        // If this Howl is no longer the owner (user skipped to a new
        // track, the Howl got unloaded, etc.), its end event is a
        // leftover — don't run the next-track logic.
        if (sharedHowl !== howl) return
        cancelAnimationFrame(sharedRaf)

        // Increment play count (look up latest count from tracks ref)
        const latest = tracksRef.current.find(tr => tr.id === track.id)
        const newCount = (Number(latest?.playCount ?? track.playCount) || 0) + 1
        libDispatchRef.current({
          type: 'UPDATE_TRACKS',
          updates: [{ id: track.id, field: 'playCount', value: String(newCount) }],
        })
        window.electronAPI.saveMetadataOverride(track.id, 'playCount', String(newCount))
        // 4.0 background signal: epoch ms of natural completion. Skip-ended
        // plays do not touch this. Fingerprint-bound so the override survives
        // restart (App.tsx applies on load with numeric coercion).
        const playedFp = `${(track.title || '').toLowerCase().trim()}|${(track.artist || '').toLowerCase().trim()}|${track.duration || 0}`
        window.electronAPI.saveMetadataOverride(track.id, 'lastPlayedAt', String(Date.now()), playedFp)
        // Record play for Music Man taste learning
        window.electronAPI.recordPlay?.({ title: track.title, artist: track.artist, album: track.album, genre: track.genre })

        const s = stateRef.current
        if (s.repeat === 'one') {
          loadAndPlay(track, s.queue, s.queueIndex)
          return
        }
        let nextIdx: number
        if (s.shuffle) {
          nextIdx = Math.floor(Math.random() * s.queue.length)
          if (s.queue.length > 1 && nextIdx === s.queueIndex) {
            nextIdx = (nextIdx + 1) % s.queue.length
          }
        } else {
          nextIdx = s.queueIndex + 1
          if (nextIdx >= s.queue.length) {
            if (autoDjMode) {
              // Check if DJ mode is actually active and listening
              let handled = false
              const ackHandler = () => { handled = true }
              window.addEventListener('musicman-dj-set-ended-ack', ackHandler, { once: true })
              window.dispatchEvent(new Event('musicman-dj-set-ended'))
              window.removeEventListener('musicman-dj-set-ended-ack', ackHandler)
              if (handled) return
              // Nobody handled it — force off
              console.warn('[Audio] DJ set-ended not handled, forcing autoDjMode off')
              autoDjMode = false
            }
            if (s.repeat === 'all') nextIdx = 0
            else {
              dispatchRef.current({ type: 'STOP' })
              return
            }
          }
        }
        const nextTrack = s.queue[nextIdx]
        if (!nextTrack) return
        if (autoDjMode) {
          // Check if a DJ transition handler is actually listening
          let handled = false
          const ackHandler = () => { handled = true }
          window.addEventListener('musicman-dj-transition-ack', ackHandler, { once: true })
          window.dispatchEvent(new CustomEvent('musicman-dj-transition', {
            detail: { prevTrack: track, nextTrack, nextIdx, queue: s.queue }
          }))
          window.removeEventListener('musicman-dj-transition-ack', ackHandler)
          if (handled) return
          // Nobody handled it — autoDjMode is stale, force it off and play normally
          console.warn('[Audio] DJ transition not handled, forcing autoDjMode off')
          autoDjMode = false
        }
        dispatchRef.current({ type: 'PLAY_TRACK', track: nextTrack, queue: s.queue, queueIndex: nextIdx })
        loadAndPlay(nextTrack, s.queue, nextIdx)
      },
      onloaderror: (_id: number, err: unknown) => {
        console.error('Audio load error:', err, url)
      }
    })

    sharedHowl = howl
    howl.play()
  }, [updatePosition])

  // Bind the crossfade-start callable to the ref so updatePosition can
  // reach it without forming a circular useCallback dep cycle.
  useEffect(() => {
    startCrossfadeRef.current = (track, queue, queueIndex) => {
      loadAndPlay(track, queue, queueIndex, true)
    }
  }, [loadAndPlay])

  const playTrack = useCallback((track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean) => {
    if (autoDjMode && !djTransition) {
      window.dispatchEvent(new Event('musicman-dj-cancel'))
    }
    const q = queue ?? stateRef.current.queue
    const qi = queueIndex ?? 0
    dispatchRef.current({ type: 'PLAY_TRACK', track, queue: q, queueIndex: qi })
    loadAndPlay(track, q, qi)
  }, [loadAndPlay])

  const togglePlayPause = useCallback(() => {
    if (stateRef.current.isPlaying) {
      isPaused = true
      cancelAnimationFrame(sharedRaf)
      sharedHowl?.pause()
      dispatchRef.current({ type: 'PAUSE' })
    } else if (stateRef.current.nowPlaying) {
      isPaused = false
      sharedHowl?.play()
      dispatchRef.current({ type: 'RESUME' })
    }
  }, [])

  const nextTrack = useCallback(() => {
    const s = stateRef.current
    if (s.queue.length === 0) return
    // Record skip if current song was playing and less than 80% complete
    // (artist-aggregate stats — feeds listener-profile.json for Music Man taste).
    if (s.currentTrack && s.duration > 0 && (s.position / s.duration) < 0.8) {
      window.electronAPI.recordSkip?.({ title: s.currentTrack.title, artist: s.currentTrack.artist })
    }
    // 4.0 background signal: per-track skipCount on sub-30s bail. Stronger
    // negative signal than the 80% gate; feeds recommendation filtering.
    if (s.currentTrack && s.position < 30) {
      const ct = s.currentTrack
      const latest = tracksRef.current.find(tr => tr.id === ct.id)
      const newCount = (Number(latest?.skipCount ?? ct.skipCount) || 0) + 1
      const skipFp = `${(ct.title || '').toLowerCase().trim()}|${(ct.artist || '').toLowerCase().trim()}|${ct.duration || 0}`
      window.electronAPI.saveMetadataOverride(ct.id, 'skipCount', String(newCount), skipFp)
    }
    let nextIdx: number
    if (s.shuffle) {
      nextIdx = Math.floor(Math.random() * s.queue.length)
      // Avoid repeating same track if possible
      if (s.queue.length > 1 && nextIdx === s.queueIndex) {
        nextIdx = (nextIdx + 1) % s.queue.length
      }
    } else {
      nextIdx = s.queueIndex + 1
      if (nextIdx >= s.queue.length) {
        if (s.repeat === 'all') nextIdx = 0
        else return
      }
    }
    const track = s.queue[nextIdx]
    if (track) playTrack(track, s.queue, nextIdx)
  }, [playTrack])

  const prevTrack = useCallback(() => {
    const s = stateRef.current
    if (s.queue.length === 0) return
    // If more than 3 seconds in, restart current track
    if (s.position > 3 && sharedHowl) {
      sharedHowl.seek(0)
      dispatchRef.current({ type: 'SET_POSITION', position: 0 })
      return
    }
    // In shuffle mode, go back through shuffle history
    if (s.shuffle && s.shuffleHistory.length > 0) {
      const history = [...s.shuffleHistory]
      const prevIdx = history.pop()!
      dispatchRef.current({ type: 'SET_SHUFFLE_HISTORY', history })
      const track = s.queue[prevIdx]
      if (track) {
        dispatchRef.current({ type: 'PLAY_TRACK', track, queue: s.queue, queueIndex: prevIdx, skipHistory: true })
        loadAndPlay(track, s.queue, prevIdx)
      }
      return
    }
    let prevIdx = s.queueIndex - 1
    if (prevIdx < 0) {
      if (s.repeat === 'all') prevIdx = s.queue.length - 1
      else prevIdx = 0
    }
    const track = s.queue[prevIdx]
    if (track) playTrack(track, s.queue, prevIdx)
  }, [playTrack, loadAndPlay])

  const seek = useCallback((pct: number) => {
    if (sharedHowl && stateRef.current.duration > 0) {
      const pos = pct * stateRef.current.duration
      sharedHowl.seek(pos)
      dispatchRef.current({ type: 'SET_POSITION', position: pos })
    }
  }, [])

  const setVolume = useCallback((v: number) => {
    if (sharedHowl) sharedHowl.volume(v)
    dispatchRef.current({ type: 'SET_VOLUME', volume: v })
  }, [])

  useEffect(() => {
    if (sharedHowl) sharedHowl.volume(state.volume)
  }, [state.volume])

  // Hard stop — unloads the audio source AND clears playback state.
  // Plain dispatch({type:'STOP'}) only clears state; the Howl keeps
  // streaming audio, which is why deleting the currently-playing
  // track left music playing from a ghost source.
  const stopPlayback = useCallback(() => {
    isPaused = true
    cancelAnimationFrame(sharedRaf)
    cleanupCrossfadeAudio()
    if (sharedHowl) {
      try { sharedHowl.stop() } catch { /* ignore */ }
      try { sharedHowl.unload() } catch { /* ignore */ }
      sharedHowl = null
    }
    dispatchRef.current({ type: 'STOP' })
  }, [])

  return { playTrack, togglePlayPause, nextTrack, prevTrack, seek, setVolume, stopPlayback }
}
