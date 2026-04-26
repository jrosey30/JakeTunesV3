import { useRef, useEffect, useCallback } from 'react'
import { Howl } from 'howler'
import { usePlayback } from '../context/PlaybackContext'
import { useLibrary } from '../context/LibraryContext'
import { Track } from '../types'
import { attachHowlToEq } from '../audio/eq'

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
//
// The PLAY_TRACK dispatch for the incoming track is DEFERRED until the
// fade actually completes. We hold onto the pending track/queue/index
// in module state and dispatch them when progress hits 1.0. This
// matches iTunes' behavior: during the overlap window the user keeps
// seeing the old track's progress bar advance through its tail, then
// the UI snaps to the new track once the fade is done. Without this
// deferral, PLAY_TRACK fires immediately at trigger time — which
// resets position/duration to 0 and freezes the bar at "remaining N
// seconds" until the new Howl finishes loading.
let crossfadeSettings = { enabled: false, seconds: 6 }
let outgoingHowl: Howl | null = null
let crossfading = false
let crossfadeStartedAtMs = 0
let crossfadePendingTrack: Track | null = null
let crossfadePendingQueue: Track[] | null = null
let crossfadePendingIdx = -1
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
  crossfadePendingTrack = null
  crossfadePendingQueue = null
  crossfadePendingIdx = -1
}

// ── Gapless playback (4.0) ──
// Always-on. Pre-loads the next track in the last few seconds of the
// current track, then promotes it on natural end so there's no decode
// latency at the seam. Decoupled from crossfade — when crossfade is
// enabled, crossfade takes priority and we skip the gapless preload.
//
// The preload Howl uses Web Audio mode (html5: false) — Howler decodes
// the file into memory at preload time and plays via AudioBufferSource.
// play() is then effectively sample-accurate, which is what makes the
// transition truly gapless. The streaming (html5: true) path that the
// rest of playback uses can't do this: play() on a fresh HTMLAudio
// element carries 50–300ms of startup latency which is exactly the gap
// users hear at the seam. The cost is memory — ~30-50MB per decoded
// song, held only during the preload window.
//
// EQ note: the EQ chain hooks via MediaElementAudioSourceNode, which
// only exists for html5: true Howls. After a gapless transition the
// new sharedHowl is html5: false and bypasses EQ until the user picks
// a different track. EQ is off by default; the trade-off is acceptable.
//
// We still PRE-WARM with play() at volume 0 a beat before the seam.
// Even Web Audio's first play() has microsecond-scale setup; the
// pre-warm makes that vanish under the current track's tail. Lead time
// is small (50ms) since Web Audio doesn't need much head start.
let gaplessNextHowl: Howl | null = null
let gaplessNextTrack: Track | null = null
let gaplessNextQueue: Track[] | null = null
let gaplessNextIdx = -1
let gaplessNextPrewarmed = false
const GAPLESS_PREWARM_LEAD_MS = 50
function cleanupGaplessPreload() {
  if (gaplessNextHowl) {
    try { gaplessNextHowl.stop() } catch { /* ignore */ }
    try { gaplessNextHowl.unload() } catch { /* ignore */ }
    gaplessNextHowl = null
  }
  gaplessNextTrack = null
  gaplessNextQueue = null
  gaplessNextIdx = -1
  gaplessNextPrewarmed = false
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

  // Held by refs so updatePosition can call them without forming
  // circular useCallback dep cycles back through loadAndPlay (which
  // itself depends on updatePosition).
  const startCrossfadeRef = useRef<((track: Track, queue: Track[], queueIndex: number) => void) | null>(null)
  const runNaturalEndRef = useRef<((track: Track, howl: Howl, endedHolder: { v: boolean }) => void) | null>(null)

  const updatePosition = useCallback(() => {
    if (isPaused) return

    // Crossfade volume animation. Runs every tick the fade is active —
    // even before the new sharedHowl has finished loading. Without this
    // de-coupling from sharedHowl.playing(), the volume curve only
    // started animating after the new Howl's onplay fired, by which
    // time the user heard the old track at full volume against a muted
    // new track (no overlap).
    if (crossfading && outgoingHowl) {
      const fadeMs = crossfadeSettings.seconds * 1000
      const elapsedMs = Date.now() - crossfadeStartedAtMs
      const progress = Math.max(0, Math.min(1, elapsedMs / fadeMs))
      const targetVol = stateRef.current.volume
      try { outgoingHowl.volume(targetVol * (1 - progress)) } catch { /* ignore */ }
      if (sharedHowl) {
        try { sharedHowl.volume(targetVol * progress) } catch { /* ignore */ }
      }
      if (progress >= 1) {
        // Fade complete — promote the new track to nowPlaying. We
        // deferred this dispatch from the trigger code so the user saw
        // the old track's progress bar advance smoothly through the
        // overlap window. Order matters: PLAY_TRACK resets position/
        // duration to 0, so we follow it with SET_POSITION /
        // SET_DURATION reading from the new sharedHowl to avoid a
        // single-frame "0:00 / 0:00" flicker.
        const pendingTrack = crossfadePendingTrack
        const pendingQueue = crossfadePendingQueue
        const pendingIdx = crossfadePendingIdx
        cleanupCrossfadeAudio()  // clears outgoing + pending state
        if (pendingTrack && pendingQueue) {
          dispatchRef.current({
            type: 'PLAY_TRACK',
            track: pendingTrack,
            queue: pendingQueue,
            queueIndex: pendingIdx,
          })
          if (sharedHowl && sharedHowl.playing()) {
            const newDur = sharedHowl.duration()
            const newPos = sharedHowl.seek() as number
            if (newDur > 0) dispatchRef.current({ type: 'SET_DURATION', duration: newDur })
            dispatchRef.current({ type: 'SET_POSITION', position: newPos })
          }
        }
      }
    }

    // Position bar source. Prefer sharedHowl once it's actively
    // playing. While the new Howl is still loading at the start of a
    // crossfade, fall back to the OUTGOING howl — the user is still
    // hearing it, so the bar should keep advancing through its tail.
    const positionHowl =
      (sharedHowl && sharedHowl.playing()) ? sharedHowl :
      (outgoingHowl && outgoingHowl.playing()) ? outgoingHowl :
      null
    if (positionHowl) {
      const pos = positionHowl.seek() as number
      dispatchRef.current({ type: 'SET_POSITION', position: pos })
      const dur = positionHowl.duration()
      if (dur > 0) {
        dispatchRef.current({ type: 'SET_DURATION', duration: dur })
      }
    }

    // Gapless preload + crossfade trigger only run when sharedHowl is
    // the active output (not during a crossfade tail, where sharedHowl
    // is the incoming track and its position is irrelevant for these
    // checks).
    if (sharedHowl && sharedHowl.playing() && !crossfading) {
      const pos = sharedHowl.seek() as number
      const dur = sharedHowl.duration()

      // Gapless preload: in the last ~3 seconds of the current track,
      // create a Howl for the next track. The audio file decode happens
      // during the current track's tail, so when the natural end fires
      // we can promote the preloaded Howl with near-zero latency.
      // Skipped when crossfade is enabled (crossfade does its own
      // overlap), DJ Mode is on, repeat=one, or no next track exists.
      if (
        !crossfadeSettings.enabled &&
        !autoDjMode &&
        !gaplessNextHowl &&
        dur > 4
      ) {
        const remaining = dur - pos
        if (remaining > 0 && remaining <= 3) {
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
                const { url: nextUrl, format: nextFormat } = ipodPathToAudioURL(nextTrack.path || '')
                const preload = new Howl({
                  src: [nextUrl],
                  format: [nextFormat],
                  html5: false,    // Web Audio: decoded buffer, sample-accurate play()
                  loop: false,
                  volume: 0,
                  preload: true,
                  autoplay: false,
                  onloaderror: () => { /* swallow — we'll fall back to normal advance */ },
                })
                gaplessNextHowl = preload
                gaplessNextTrack = nextTrack
                gaplessNextQueue = s.queue
                gaplessNextIdx = nextIdx
                gaplessNextPrewarmed = false
              }
            }
          }
        }
      }

      // Gapless pre-warm: ~150ms before the current track ends, kick
      // the preload Howl into actual playback at volume 0. Without this,
      // play() is first called inside onend — and that play() carries
      // 50–200ms of HTMLAudio startup latency, which is the audible gap.
      // Pre-warming lets that latency happen DURING the current track's
      // tail, so promotion at onend is a near-instant volume change.
      if (
        gaplessNextHowl &&
        !gaplessNextPrewarmed &&
        !crossfadeSettings.enabled
      ) {
        const remaining = dur - pos
        if (remaining > 0 && remaining * 1000 <= GAPLESS_PREWARM_LEAD_MS) {
          try { gaplessNextHowl.volume(0) } catch { /* ignore */ }
          try { gaplessNextHowl.play() } catch { /* ignore */ }
          gaplessNextPrewarmed = true
        }
      }

      // Crossfade trigger: when the current track has crossfadeSeconds
      // left, kick off the fade. PLAY_TRACK is intentionally NOT
      // dispatched here — it's deferred to the fade-complete branch
      // above, so the user keeps seeing the old track during overlap.
      if (
        crossfadeSettings.enabled &&
        !autoDjMode &&
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
                startCrossfadeRef.current?.(nextTrack, s.queue, nextIdx)
              }
            }
          }
        }
      }
    }

    // Reschedule rAF as long as something is producing audio OR a fade
    // is mid-flight (volume animation needs to run until completion
    // even when the new sharedHowl hasn't started playing yet).
    const stillActive =
      (sharedHowl && (sharedHowl.playing() || crossfading)) ||
      (outgoingHowl && outgoingHowl.playing())
    if (stillActive) {
      sharedRaf = requestAnimationFrame(updatePosition)
    }
  }, [])

  const loadAndPlay = useCallback((track: Track, queue: Track[], queueIndex: number, asCrossfade: boolean = false) => {
    isPaused = false
    if (asCrossfade && sharedHowl) {
      // Hand off the current Howl to outgoing for the fade. Don't unload
      // it yet — updatePosition fades it to silence then cleans up.
      // Any prior outgoing (rare — only if a previous crossfade hadn't
      // finished) is silenced cleanly first.
      //
      // The PLAY_TRACK dispatch is intentionally deferred until fade
      // completion (handled in updatePosition). We stash the target
      // track/queue/idx here so updatePosition can dispatch them when
      // progress hits 1.0.
      //
      // Don't cancelAnimationFrame here — the rAF loop is what runs the
      // volume animation, so it has to keep ticking through the fade.
      // The non-crossfade branch below still cancels because that path
      // unloads the old Howl entirely.
      cleanupCrossfadeAudio()
      outgoingHowl = sharedHowl
      crossfading = true
      crossfadeStartedAtMs = Date.now()
      crossfadePendingTrack = track
      crossfadePendingQueue = queue
      crossfadePendingIdx = queueIndex
    } else {
      cleanupCrossfadeAudio()
      cleanupGaplessPreload()
      if (sharedHowl) {
        sharedHowl.unload()
        sharedHowl = null
      }
      cancelAnimationFrame(sharedRaf)
    }

    const { url, format } = ipodPathToAudioURL(track.path || '')
    // Guard against the Howler 'end' event firing twice for the same
    // playback, which would cause the same track to auto-play again
    // even with repeat off. Also belt-and-suspenders loop:false so no
    // underlying <audio> element ever auto-loops.
    const endedHolder = { v: false }
    const startVolume = asCrossfade ? 0 : stateRef.current.volume
    const howl = new Howl({
      src: [url],
      format: [format],
      html5: true,
      loop: false,
      volume: startVolume,
      onplay: () => {
        // EQ tap: bind the underlying HTMLAudioElement to the Web Audio
        // chain. Idempotent + a no-op when EQ is disabled. Done in onplay
        // (not after construction) because Howler's _sounds[0]._node
        // isn't populated until the element starts decoding.
        attachHowlToEq(howl)
        if (asCrossfade) {
          // The rAF loop is already running; updatePosition will pick
          // up this Howl on its next tick. Don't dispatch SET_DURATION
          // either — the deferred PLAY_TRACK at fade-completion will
          // dispatch it together with SET_POSITION to keep the bar
          // continuous.
          return
        }
        dispatchRef.current({ type: 'SET_DURATION', duration: howl.duration() })
        sharedRaf = requestAnimationFrame(updatePosition)
      },
      onend: () => {
        runNaturalEndRef.current?.(track, howl, endedHolder)
      },
      onloaderror: (_id: number, err: unknown) => {
        console.error('Audio load error:', err, url)
      }
    })

    sharedHowl = howl
    howl.play()
  }, [updatePosition])

  // Bind the natural-end handler to a ref so both this loadAndPlay's
  // Howl and gapless-promoted Howls (which need the same recursive
  // advance logic) can share it. Body extracted from the prior inline
  // onend so we can reuse it from the gapless promote path below.
  useEffect(() => {
    runNaturalEndRef.current = (track, howl, endedHolder) => {
      if (endedHolder.v) return
      endedHolder.v = true
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
      // 4.0 background signal: epoch ms of natural completion.
      const playedFp = `${(track.title || '').toLowerCase().trim()}|${(track.artist || '').toLowerCase().trim()}|${track.duration || 0}`
      window.electronAPI.saveMetadataOverride(track.id, 'lastPlayedAt', String(Date.now()), playedFp)
      window.electronAPI.recordPlay?.({ title: track.title, artist: track.artist, album: track.album, genre: track.genre })

      const s = stateRef.current
      if (s.repeat === 'one') {
        cleanupGaplessPreload()
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
            let handled = false
            const ackHandler = () => { handled = true }
            window.addEventListener('musicman-dj-set-ended-ack', ackHandler, { once: true })
            window.dispatchEvent(new Event('musicman-dj-set-ended'))
            window.removeEventListener('musicman-dj-set-ended-ack', ackHandler)
            if (handled) return
            console.warn('[Audio] DJ set-ended not handled, forcing autoDjMode off')
            autoDjMode = false
          }
          if (s.repeat === 'all') nextIdx = 0
          else {
            cleanupGaplessPreload()
            dispatchRef.current({ type: 'STOP' })
            return
          }
        }
      }
      const nextTrack = s.queue[nextIdx]
      if (!nextTrack) return
      if (autoDjMode) {
        let handled = false
        const ackHandler = () => { handled = true }
        window.addEventListener('musicman-dj-transition-ack', ackHandler, { once: true })
        window.dispatchEvent(new CustomEvent('musicman-dj-transition', {
          detail: { prevTrack: track, nextTrack, nextIdx, queue: s.queue }
        }))
        window.removeEventListener('musicman-dj-transition-ack', ackHandler)
        if (handled) return
        console.warn('[Audio] DJ transition not handled, forcing autoDjMode off')
        autoDjMode = false
      }

      // GAPLESS PROMOTE: if a preloaded Howl matches the next track,
      // skip loadAndPlay and promote the preloaded Howl. This avoids
      // the load+decode latency at the seam — true near-gapless.
      if (
        gaplessNextHowl &&
        gaplessNextTrack &&
        gaplessNextTrack.id === nextTrack.id &&
        !crossfadeSettings.enabled  // crossfade has its own preload path
      ) {
        const next = gaplessNextHowl
        const nt = gaplessNextTrack
        const nq = gaplessNextQueue || s.queue
        const ni = gaplessNextIdx >= 0 ? gaplessNextIdx : nextIdx
        const wasPrewarmed = gaplessNextPrewarmed
        // Detach gapless state — we're handing off
        gaplessNextHowl = null
        gaplessNextTrack = null
        gaplessNextQueue = null
        gaplessNextIdx = -1
        gaplessNextPrewarmed = false
        // Wire up the preloaded Howl's lifecycle (it was created without
        // these handlers in the preload step).
        const nextEndedHolder = { v: false }
        next.once('end', () => {
          runNaturalEndRef.current?.(nt, next, nextEndedHolder)
        })
        // Unload the just-finished Howl, promote the preload to shared.
        try { howl.unload() } catch { /* ignore */ }
        sharedHowl = next
        if (wasPrewarmed) {
          // The preload was already started silently in the last
          // ~150ms of the previous track. Just bump the volume — it's
          // already producing audio. No play() call (which would fail
          // anyway since Howler considers the howl already playing).
          // 'play' didn't fire on the SoundManager listener path, so
          // dispatch SET_DURATION + EQ binding manually here.
          try { next.volume(s.volume) } catch { /* ignore */ }
          attachHowlToEq(next)
          dispatchRef.current({ type: 'SET_DURATION', duration: next.duration() })
          dispatchRef.current({ type: 'PLAY_TRACK', track: nt, queue: nq, queueIndex: ni })
          // Re-anchor the position bar — the deferred SET_POSITION will
          // reach the correct value on the next rAF tick (already
          // running from the prior track).
          if (!sharedRaf) sharedRaf = requestAnimationFrame(updatePosition)
        } else {
          // Pre-warm didn't fire (very short track, or rAF hadn't ticked
          // inside the last 150ms). Fall back to standard promote: wire
          // a play handler then call play() ourselves.
          next.once('play', () => {
            dispatchRef.current({ type: 'SET_DURATION', duration: next.duration() })
            attachHowlToEq(next)
            sharedRaf = requestAnimationFrame(updatePosition)
          })
          next.volume(s.volume)
          next.play()
          dispatchRef.current({ type: 'PLAY_TRACK', track: nt, queue: nq, queueIndex: ni })
        }
        return
      }

      // Standard advance — preload didn't match (or wasn't ready).
      cleanupGaplessPreload()
      dispatchRef.current({ type: 'PLAY_TRACK', track: nextTrack, queue: s.queue, queueIndex: nextIdx })
      loadAndPlay(nextTrack, s.queue, nextIdx)
    }
  }, [loadAndPlay, updatePosition])

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
    cleanupGaplessPreload()
    if (sharedHowl) {
      try { sharedHowl.stop() } catch { /* ignore */ }
      try { sharedHowl.unload() } catch { /* ignore */ }
      sharedHowl = null
    }
    dispatchRef.current({ type: 'STOP' })
  }, [])

  return { playTrack, togglePlayPause, nextTrack, prevTrack, seek, setVolume, stopPlayback }
}
