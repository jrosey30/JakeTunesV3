import { useRef, useEffect, useCallback } from 'react'
import { Howl } from 'howler'
import { usePlayback } from '../context/PlaybackContext'
import { useLibrary } from '../context/LibraryContext'
import { Track } from '../types'
import { attachHowlToEq, detachHowlFromEq, resumeEqContext } from '../audio/eq'
import {
  scheduleAbsoluteFadeOut,
  scheduleAbsoluteStart,
  decodeUrl,
  promoteBufferSourceToHowl,
  type ScheduledIncoming,
} from '../audio/seamScheduler'

// 4.5.0-78 — sample-accurate seam scheduling. See seamScheduler.ts
// header for the full rationale. Flag-gated so flipping to false
// restores the pre-78 Howler-only path instantly.
const USE_SAMPLE_ACCURATE_SEAMS = true

// 4.5.0-54: REVERTED the AudioContext sample-rate pin from 4.5.0-52.
// Setting Howler.ctx to a pre-created suspended AudioContext broke
// playback entirely in Radio Mode (and likely elsewhere) — Howler's
// auto-resume on user gesture doesn't fire for a context it didn't
// create itself. Pops + sample-rate alignment will be revisited via
// a different mechanism (per-track context, or Howler-bypass at the
// seam) — see Grok consult notes.

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
// Throttle clock for SET_POSITION dispatches — see updatePosition.
// 100ms = 10Hz UI updates, way less render-thread pressure than 60Hz.
let lastPositionDispatchMs = 0

// Brief 012c — diagnostic logging. Flip to false to silence, or delete
// the dx.* call sites in Brief 012d once the root cause is identified.
// All dx.* logs go through console.log (not logAudioEvent) so they're
// visible regardless of the ring-buffer skip-tick filter. Prefixed with
// `[dx]` so they're easy to grep in the captured devtools console.
const DIAGNOSTIC_LOGGING = false  // Brief 015e: silenced after 015d fix verified through real listening sessions. Flip back to true and rebuild if a future bug needs the dx.* instrumentation.
let rafTickCount = 0
function dx(ev: string, detail?: unknown) {
  if (!DIAGNOSTIC_LOGGING) return
  console.log('[dx]', ev, detail ?? '')
}

// Watchdog state for the "stuck audio" recovery (Airfoil hijack edge
// case). When the underlying HTMLAudioElement gets stuck because Core
// Audio renegotiated the output device under us, position stops
// advancing while React state still says isPlaying=true. The user's
// pause/play toggle doesn't recover it because the Howl itself is in a
// broken state. After WATCHDOG_STUCK_THRESHOLD_MS of confirmed stuck
// state, we forcibly recreate the Howl from scratch and resume from
// the last known position.
//
// Conservative thresholds — transient pauses (buffer underruns, brief
// device blips, mouse-move stutter) recover in milliseconds, well
// under 5 sec, so they never trigger this. The 30-sec cooldown
// prevents recovery loops if the recreated Howl also gets stuck.
const WATCHDOG_STUCK_THRESHOLD_MS = 5000
const WATCHDOG_COOLDOWN_MS = 30000
let watchdogLastObservedPos = -1
let watchdogLastAdvanceMs = 0
let watchdogLastRecoveryMs = 0
let watchdogRecoveryInFlight = false

// ── Diagnostic ring buffer (4.0.9) ──────────────────────────────────────
// Capture the last 50 audio-pipeline events so when "music stops playing"
// happens, we can pull recent events with one command instead of guessing.
// Type `__audioLog()` in the dev console to dump.
interface AudioLogEntry { t: number; ev: string; detail?: unknown }
const audioLogBuffer: AudioLogEntry[] = []
export function logAudioEvent(ev: string, detail?: unknown) {
  audioLogBuffer.push({ t: Date.now(), ev, detail })
  // Mirror to disk so a failure can be read AFTER the fact, without a
  // debugger and without a relaunch. See the audio-log handler in main.
  try {
    window.electronAPI?.audioLog?.(
      new Date().toISOString() + ' ' + ev + ' ' + JSON.stringify(detail ?? '').slice(0, 300),
    )
  } catch { /* never let logging break playback */ }
  if (audioLogBuffer.length > 50) audioLogBuffer.shift()
  // Skip the very chatty position-tick events from console output but
  // keep the structural ones. Everything still lands in the buffer.
  if (ev !== 'tick') console.log('[Audio]', ev, detail ?? '')
}
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__audioLog = () => {
    console.table(audioLogBuffer.map(e => ({
      ms_ago: Date.now() - e.t,
      time: new Date(e.t).toISOString().slice(11, 23),
      event: e.ev,
      detail: typeof e.detail === 'object' ? JSON.stringify(e.detail) : e.detail,
    })))
    return audioLogBuffer
  }
}

// Native HTMLAudioElement events that explain "audio stopped" cases
// Howler doesn't surface. Attached to the underlying <audio> element
// once Howler has loaded (we grab it from howl._sounds[0]._node).
const NATIVE_AUDIO_EVENTS = ['stalled', 'suspend', 'waiting', 'error', 'emptied', 'abort', 'canplay', 'playing'] as const
function attachNativeListeners(howl: Howl, label: string) {
  type HowlInternal = Howl & { _sounds?: Array<{ _node?: HTMLAudioElement }> }
  const node = (howl as HowlInternal)._sounds?.[0]?._node
  if (!node) {
    logAudioEvent(`${label}.no-native-node`)
    return
  }
  for (const ev of NATIVE_AUDIO_EVENTS) {
    node.addEventListener(ev, () => {
      const detail = ev === 'error' ? { code: node.error?.code, msg: node.error?.message } : undefined
      logAudioEvent(`${label}.native:${ev}`, detail)
    })
  }
}

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
    detachHowlFromEq(outgoingHowl)
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
// 4.5.0-70 — pop reproduction analysis on the -65 design exposed two
// real waveform-discontinuity sources at every seam:
//
//   POP #1 (outgoing). rAF runs at 60 Hz (~16.7 ms per tick) so the
//   fade-out check, which fires when `remaining ≤ FADE_MS`, can land
//   when remaining is anywhere in [0, FADE_MS]. In -65 the fade was
//   triggered AND lasted 25 ms — meaning the fade routinely COMPLETED
//   10–20 ms after onend, so the outgoing track's gain was still
//   ~0.4–0.7 at the seam. The buffer ended at non-zero amplitude →
//   speaker cone snap → audible pop.
//   Fix: trigger the fade-out at remaining ≤ FADE_TRIGGER_MS (60 ms),
//   and use FADE_DURATION_MS (40 ms). Even if rAF fires at the very
//   end of the trigger window (remaining=0), the fade still has 40 ms
//   to ramp — covered by the outgoing buffer's natural tail PLUS the
//   incoming fade-in mask. In the typical case the fade COMPLETES with
//   20+ ms of clean silence on the outgoing before onend.
//
//   POP #2 (incoming). A 5 ms gain-ramp from 0→target is effectively
//   a step function for any track whose first sample has non-zero
//   amplitude (most music — encoder padding only buys 1–2 ms of
//   silence). Audible click. Fix: 20 ms fade-in. Long enough that the
//   ear hears smooth onset, short enough that no perceived "swell."
//
//   We still skip the prewarm so the user hears the next track from
//   sample 0 (no missed audio). The 20 ms fade-in masks the buffer-
//   start discontinuity instead.
// 4.5.0-78 — sample-accurate seam state. Lives alongside the existing
// gapless preload because the runNaturalEnd handoff still needs a Howl
// to promote to (the BufferSource only owns playback for ~5 s across
// the seam). Phase A: pre-decode the incoming buffer (~10 s before
// seam). Phase B: schedule absolute-time fade-out + BufferSource start
// at the precise seam moment. Phase C: on onend, promote BufferSource
// to Howl via internal crossfade.
let seamIncomingBuffer: AudioBuffer | null = null
let seamIncomingBufferUrl: string | null = null
let seamScheduled: ScheduledIncoming | null = null
let seamFadeOutScheduled = false
let seamStartScheduled = false

function cleanupSeamScheduler() {
  if (seamScheduled) {
    try { seamScheduled.stop() } catch { /* ignore */ }
    seamScheduled = null
  }
  seamIncomingBuffer = null
  seamIncomingBufferUrl = null
  seamFadeOutScheduled = false
  seamStartScheduled = false
}

let gaplessNextHowl: Howl | null = null
let gaplessNextTrack: Track | null = null
let gaplessNextQueue: Track[] | null = null
let gaplessNextIdx = -1
let gaplessNextPrewarmed = false
let gaplessOutgoingFaded = false
const GAPLESS_PREWARM_LEAD_MS = 0
const GAPLESS_FADE_OUT_TRIGGER_MS = 60   // when to KICK the outgoing fade
const GAPLESS_FADE_OUT_DURATION_MS = 40  // how long the outgoing fade runs
const GAPLESS_FADE_IN_MS = 20            // incoming fade-in duration
// Legacy name kept so any other reader of this module sees the canonical
// "seam fade" value — equals the duration, not the trigger.
const GAPLESS_SEAM_FADE_MS = GAPLESS_FADE_OUT_DURATION_MS

// Howls start at volume 0 and fade up (pop suppression). Howler's fade()
// is queued while `_playLock` is set (the HTMLAudioElement.play() promise),
// and that queued fade is never drained — `_loadQueue('play')` only pops
// tasks whose event is 'play'. Result: Howl stays at 0, UI shows playing,
// sliding the volume bar calls volume() and "wakes" the song. Snap after
// the fade window so a stuck fade can't leave the track silent.
function ensureHowlAudible(howl: Howl | null, target: number): void {
  // Skip while the OUTGOING track is fading to zero (sharedHowl still
  // that track). Must not skip after promote — gaplessOutgoingFaded is
  // cleared on handoff; if it weren't, every seam snap would no-op and
  // the next song would sit silent until the volume bar.
  if (!howl || crossfading) return
  if (gaplessOutgoingFaded && howl === sharedHowl) return
  if (!(target > 0.02)) return
  try {
    const cur = howl.volume() as number
    if (!cur || cur < 0.02) howl.volume(target)
  } catch { /* ignore */ }
}
function fadeInHowl(howl: Howl, target: number, ms: number): void {
  try { howl.fade(0, target, ms) } catch {
    try { howl.volume(target) } catch { /* ignore */ }
    return
  }
  window.setTimeout(() => ensureHowlAudible(howl, target), ms + 40)
}
function cleanupGaplessPreload() {
  if (gaplessNextHowl) {
    try { gaplessNextHowl.stop() } catch { /* ignore */ }
    detachHowlFromEq(gaplessNextHowl)
    try { gaplessNextHowl.unload() } catch { /* ignore */ }
    gaplessNextHowl = null
  }
  gaplessNextTrack = null
  gaplessNextQueue = null
  gaplessNextIdx = -1
  gaplessNextPrewarmed = false
  gaplessOutgoingFaded = false
  // 4.5.0-78 — also tear down the seam scheduler's incoming buffer +
  // any scheduled BufferSource. Cleared on any track change / stop /
  // crossfade kick that abandons the gapless slot.
  cleanupSeamScheduler()
}

// ── Hover prefetch (4.5) ──
// When the user mouses over a track row, decode it in the background
// with Web Audio (html5: false) so a click-to-play promotion lands on
// an already-decoded buffer instead of starting a fresh HTMLAudioElement
// pipeline. HTMLAudio first-play carries 500–1500 ms of setup latency
// even on warm files; Web Audio play() on a pre-decoded buffer is
// effectively instant.
//
// One prefetch slot only — a fresh hover evicts the prior, and a
// real playback take-over (loadAndPlay) consumes the slot. The 150ms
// debounce avoids hammering disk/decoder on fast row-to-row mouse
// movement. EQ bypass for prefetched plays is the same trade-off the
// gapless preload already accepts (EQ is off by default).
let prefetchHowl: Howl | null = null
let prefetchTrackId: string | number | null = null
let prefetchDebounceTimer: number = 0

function clearPrefetch() {
  if (prefetchHowl) {
    try { prefetchHowl.unload() } catch { /* ignore */ }
    prefetchHowl = null
  }
  prefetchTrackId = null
}

// 4.5: fade-on-quit. Main process intercepts before-quit and pings the
// renderer via 'app-quit-fade' IPC; App.tsx subscribes and calls this.
// Ramps every live Howl to 0 over ~120ms so the OS audio buffers aren't
// snapped from mid-waveform amplitude — eliminates the speaker-cone
// pop on cmd+Q. Resolves once the fade window has elapsed so the
// caller can let the quit proceed.
export function fadeAllForQuit(durMs: number = 120): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (sharedHowl) {
        try {
          const v = sharedHowl.volume() as number
          sharedHowl.fade(v, 0, durMs)
        } catch { /* ignore */ }
      }
      if (outgoingHowl) {
        try {
          const v = outgoingHowl.volume() as number
          outgoingHowl.fade(v, 0, durMs)
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    window.setTimeout(resolve, durMs + 20)
  })
}

export function prefetchTrackForPlay(track: Track) {
  if (!track || !track.path) return
  if (prefetchTrackId === track.id) return
  if (prefetchDebounceTimer) {
    window.clearTimeout(prefetchDebounceTimer)
    prefetchDebounceTimer = 0
  }
  // 4.5: 150ms → 60ms. The longer debounce reliably caught row-to-row
  // mouse sweeps without firing, but it also meant fast clicks
  // (hover for ~100ms then click) got no prefetch at all and hit the
  // full cold-load latency Jake noticed on "some songs". 60ms catches
  // any hover that's deliberate enough to count, including a brief
  // pause before clicking.
  prefetchDebounceTimer = window.setTimeout(() => {
    prefetchDebounceTimer = 0
    if (prefetchTrackId === track.id) return
    clearPrefetch()
    const { url, format } = ipodPathToAudioURL(track.path || '')
    prefetchTrackId = track.id
    prefetchHowl = new Howl({
      src: [url],
      format: [format],
      // Same reason as the main path: Web Audio XHRs the file, and on an XHR
      // error howler.js:2430 silently switches to html5 and EMPTIES _sounds,
      // destroying the queued play(). This Howl gets PROMOTED into the main
      // slot on track change, so leaving it in Web Audio kept auto-advance
      // broken ("the next song never plays") after the main path was fixed.
      html5: true,
      preload: true,
      autoplay: false,
      volume: 0,
      onloaderror: () => {
        if (prefetchTrackId === track.id) clearPrefetch()
      },
    })
  }, 60)
}

// 4.5: synchronous prefetch — bypasses the hover debounce for paths
// where intent is already certain (mousedown on a row, keyboard
// arrow selection). The click event fires ~80-200ms after mousedown
// in typical interaction, which is enough head start for the Web
// Audio decode to be well underway by the time loadAndPlay runs and
// looks for a matching prefetch.
export function prefetchTrackImmediate(track: Track) {
  if (!track || !track.path) return
  if (prefetchTrackId === track.id) return
  if (prefetchDebounceTimer) {
    window.clearTimeout(prefetchDebounceTimer)
    prefetchDebounceTimer = 0
  }
  clearPrefetch()
  const { url, format } = ipodPathToAudioURL(track.path || '')
  prefetchTrackId = track.id
  prefetchHowl = new Howl({
    src: [url],
    format: [format],
    // Same reason as the main path: Web Audio XHRs the file, and on an XHR
    // error howler.js:2430 silently switches to html5 and EMPTIES _sounds,
    // destroying the queued play(). This Howl gets PROMOTED into the main
    // slot on track change, so leaving it in Web Audio kept auto-advance
    // broken ("the next song never plays") after the main path was fixed.
    html5: true,
    preload: true,
    autoplay: false,
    volume: 0,
    onloaderror: () => {
      if (prefetchTrackId === track.id) clearPrefetch()
    },
  })
}


export function useAudio(opts?: { primary?: boolean }) {
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

  // Brief 015c: track dispatchRef freshness. useReducer's dispatch is
  // referentially stable, so this useEffect should fire exactly ONCE
  // per mount of useAudio. If we ever see two or more before an auto-
  // repeat bug fires, useAudio has remounted (e.g., PlaybackProvider
  // remounted underneath us) and there's a stale dispatchRef
  // somewhere capturing the prior cycle's dispatch function. The
  // mountId counter makes "I have N copies of useAudio in flight"
  // obvious in a single log line.
  const mountIdRef = useRef<number>(0)
  useEffect(() => {
    mountIdRef.current = (mountIdRef.current || 0) + 1
    if (DIAGNOSTIC_LOGGING) {
      console.log('[dx.repeat.dispatchref.update]', {
        src: 'useAudio.dispatchRefEffect',
        mountInvocation: mountIdRef.current,
        ts: Date.now(),
      })
    }
  }, [dispatch])

  // Notify main when isPlaying changes so background workers (audio
  // analysis, ALAC prewarm — both heavy I/O on iPod-USB sources) can
  // yield while playback is live. Fire-and-forget IPC — preload
  // exposes setPlaybackActive as one-way send.
  useEffect(() => {
    const api = window.electronAPI as Record<string, unknown> | undefined
    const fn = api && typeof api.setPlaybackActive === 'function'
      ? api.setPlaybackActive as (active: boolean) => void
      : null
    fn?.(state.isPlaying)
  }, [state.isPlaying])

  // 4.2.13: heartbeat diagnostic. Logs audio-pipeline state every 2s.
  // 4.2.14: heartbeat is now ALSO an active recovery loop:
  //   1. If AudioContext is suspended, resume it. Chromium can suspend
  //      ctxs that don't appear to be producing output, even mid-song.
  //   2. If position has been frozen for 4+ seconds (2 consecutive
  //      heartbeats at the same pos with playing:true), force-call
  //      .play() on the underlying HTMLAudio element. That's enough to
  //      kick a stalled element off its frozen tick in many cases.
  useEffect(() => {
    // Brief 033c: only the App-level instance (passed { primary: true })
    // runs the heartbeat. useAudio() is consumed by ~7 mounted components
    // at once (App + transport chrome + always-mounted MusicManView +
    // the active view); without this gate each instance spun up its own
    // 2s interval, so the diagnostic buffer logged 7 heartbeats per cycle
    // AND 7 independent recovery loops raced on the single shared Howl
    // (overlapping stop/unload/reload). App.tsx never unmounts, so making
    // it the sole owner avoids both the duplication and Option A's
    // ownership-handoff stall (a transient view winning the claim then
    // unmounting on navigation). The interval's own cleanup is unchanged
    // and still correct.
    if (!opts?.primary) return
    if (!state.isPlaying) return
    let lastPos = -1
    let stuckTicks = 0
    let lastRafTickCountSeen = rafTickCount
    const id = window.setInterval(() => {
      try {
        type HowlInternal = Howl & { _sounds?: Array<{ _node?: HTMLAudioElement }>; _state?: string }
        const h = sharedHowl as HowlInternal | null
        const node = h?._sounds?.[0]?._node
        const ctx = (window as unknown as { Howler?: { ctx?: AudioContext } }).Howler?.ctx

        // 1. Auto-resume AudioContext if suspended OR interrupted.
        // html5 Howls are routed through this ctx (MediaElementSource);
        // Howler will not auto-resume them. Also snap volume if a fade-in
        // got stuck at 0 — that's the "slide the volume bar to wake it" bug.
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
          void ctx.resume().catch(() => { /* ignore */ })
          logAudioEvent('heartbeat.ctx.resume', { state: ctx.state })
        }
        resumeEqContext()
        ensureHowlAudible(h, stateRef.current.volume)

        // 4.5.0-77 — UI-safe position recovery. The rAF loop is what
        // normally pushes SET_POSITION to React state at ~10 Hz. If
        // the loop dies (stillActive evaluates false for any reason
        // mid-track — stale sharedHowl reference, isPaused stuck, a
        // ref refresh hiccup), the position bar freezes at the last
        // dispatched value while audio keeps playing. User sees "song
        // is playing but stuck at 1:02" with no way to recover but
        // pause/play.
        //
        // Two recoveries here, both SAFE (no audio mutation, no Howl
        // recreation — past attempts at hard-recovery caused clicks
        // and were removed in 4.2.12):
        //
        //   (a) Unconditional position dispatch from the LIVE Howler
        //       seek when React state says playing. Bypasses the rAF
        //       throttle gate. Even if rAF is dead, the position bar
        //       updates every 2 s — jumpy, but at least correct.
        //   (b) Restart rAF if rafTickCount hasn't advanced since the
        //       prior heartbeat AND React state says playing. The
        //       loop's own stillActive check is the safety net — if
        //       it shouldn't be running, the new tick self-cancels.
        if (h && stateRef.current.isPlaying && !isPaused) {
          try {
            const livePos = h.seek() as number
            const liveDur = h.duration()
            dispatchRef.current({ type: 'SET_POSITION', position: livePos })
            if (liveDur > 0) dispatchRef.current({ type: 'SET_DURATION', duration: liveDur })
            lastPositionDispatchMs = Date.now()
          } catch { /* ignore */ }
          if (rafTickCount === lastRafTickCountSeen) {
            logAudioEvent('heartbeat.raf-dead-restart', { rafTickCount, pos: lastPos })
            cancelAnimationFrame(sharedRaf)
            sharedRaf = requestAnimationFrame(updatePosition)
          }
        }
        lastRafTickCountSeen = rafTickCount

        const pos = h ? Number((h.seek() as number).toFixed(2)) : null
        logAudioEvent('heartbeat', {
          pos,
          dur: h ? Number(h.duration().toFixed(2)) : null,
          playing: h ? h.playing() : null,
          state: h?._state,
          paused: isPaused,
          ctxState: ctx?.state,
          nodeReady: node?.readyState,
          nodePaused: node?.paused,
          nodeNetwork: node?.networkState,
          nodeError: node?.error?.code,
        })

        // 4.5: Stuck-position KICKER + HARD-RECOVER both DISABLED.
        // These were diagnostic-era recovery paths for the Airfoil
        // hijack edge case, but they cause MORE clicks than they fix
        // when they false-positive on a routine buffer hiccup. Calling
        // node.play() on an element that's actively playing produces a
        // click; hard-recover stops + recreates the howl which is a
        // guaranteed click. Both are gone. The user pause/play recovers
        // a genuinely-stuck stream just as well, and the heartbeat's
        // ctx.resume() above still handles the actual mid-song
        // AudioContext-suspended edge case that was the only valid
        // win these kickers ever delivered.
        const howlPlaying = h ? h.playing() : false
        if (pos !== null && howlPlaying && pos === lastPos) {
          stuckTicks++
          if (stuckTicks >= 2) {
            logAudioEvent('heartbeat.observed-stuck-no-action', { pos, stuckTicks })
            // (kick + hardRecover removed — see comment above)
            void playTrackRef.current  // keep ref alive for type-checker
          }
        } else {
          stuckTicks = 0
        }
        lastPos = pos ?? -1
      } catch { /* ignore */ }
    }, 2000)
    return () => window.clearInterval(id)
  }, [state.isPlaying, opts?.primary])

  // Held by refs so updatePosition can call them without forming
  // circular useCallback dep cycles back through loadAndPlay (which
  // itself depends on updatePosition).
  const startCrossfadeRef = useRef<((track: Track, queue: Track[], queueIndex: number) => void) | null>(null)
  // Brief 015d: 4th arg `freshQueueIndex` lets the caller pin the
  // just-dispatched queueIndex into the onend closure, sidestepping
  // stateRef.current staleness on long-playing tracks. Optional —
  // legacy callers without the arg fall back to stateRef.current.
  const runNaturalEndRef = useRef<((track: Track, howl: Howl, endedHolder: { v: boolean }, freshQueueIndex?: number) => void) | null>(null)
  // playTrackRef lets the stuck-audio watchdog (inside updatePosition)
  // recover by re-loading the current track. updatePosition is defined
  // first, so this ref is the cycle-breaker.
  const playTrackRef = useRef<((track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean) => void) | null>(null)

  const updatePosition = useCallback(() => {
    rafTickCount++
    if (rafTickCount % 60 === 0) {
      dx('raf.tick', {
        n: rafTickCount,
        isPaused,
        sharedHowl: !!sharedHowl,
        sharedHowl_playing: sharedHowl?.playing() ?? null,
        outgoingHowl: !!outgoingHowl,
        crossfading,
        react_isPlaying: stateRef.current.isPlaying,
        react_pos: stateRef.current.position,
        react_dur: stateRef.current.duration,
      })
    }
    if (isPaused) {
      dx('raf.tick.paused-return', { n: rafTickCount })
      return
    }

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
        // overlap window. Brief 012: dispatch is now atomic — duration
        // and position travel with PLAY_TRACK so the reducer reset
        // can't produce a single-frame 0:00 / 0:00 flicker. Replaces
        // the pre-Brief-012 workaround that fired SET_DURATION +
        // SET_POSITION after PLAY_TRACK to paper over the reset.
        const pendingTrack = crossfadePendingTrack
        const pendingQueue = crossfadePendingQueue
        const pendingIdx = crossfadePendingIdx
        cleanupCrossfadeAudio()  // clears outgoing + pending state
        if (pendingTrack && pendingQueue) {
          let crossfadeDur = 0
          let crossfadePos = 0
          if (sharedHowl && sharedHowl.playing()) {
            crossfadeDur = sharedHowl.duration() || 0
            crossfadePos = (sharedHowl.seek() as number) || 0
          }
          dx('playtrack.dispatch', {
            site: 'crossfade-complete',
            title: pendingTrack.title,
            duration: crossfadeDur,
            position: crossfadePos,
            sharedRaf,
            isPaused,
          })
          dispatchRef.current({
            type: 'PLAY_TRACK',
            track: pendingTrack,
            queue: pendingQueue,
            queueIndex: pendingIdx,
            duration: crossfadeDur,
            position: crossfadePos,
          })
        }
      }
    }

    // Position bar source. Prefer sharedHowl once it's actively
    // playing. While the new Howl is still loading at the start of a
    // crossfade, fall back to the OUTGOING howl — the user is still
    // hearing it, so the bar should keep advancing through its tail.
    //
    // 4.4.40 fallback: Howler's `.playing()` can return `false` even
    // when the underlying HTMLAudioElement is producing sound — happens
    // after pool reuse (4.4.9) or after Core Audio renegotiates the
    // output device mid-track (4.4.15). When that happens, React state
    // (`stateRef.current.isPlaying`) still correctly says we're playing,
    // but the position bar froze at 0:00 / -0:00 because no dispatch
    // ever fired. Last-resort: if React thinks we're playing and a
    // sharedHowl exists, dispatch position from it even if .playing()
    // is lying. seek() reads the underlying audio element directly so
    // it returns the true position even when .playing() is wrong.
    const positionHowl =
      (sharedHowl && sharedHowl.playing()) ? sharedHowl :
      (outgoingHowl && outgoingHowl.playing()) ? outgoingHowl :
      (sharedHowl && stateRef.current.isPlaying) ? sharedHowl :
      null
    if (!positionHowl && rafTickCount % 60 === 0) {
      dx('raf.posHowl-null', {
        n: rafTickCount,
        sharedHowl: !!sharedHowl,
        sharedHowl_playing: sharedHowl?.playing() ?? null,
        outgoingHowl: !!outgoingHowl,
        outgoingHowl_playing: outgoingHowl?.playing() ?? null,
        react_isPlaying: stateRef.current.isPlaying,
      })
    }
    if (positionHowl) {
      // Throttle SET_POSITION dispatch to 10Hz. The rAF loop fires at
      // 60Hz, and dispatching a React state update every frame forces
      // 60 re-renders per second on the renderer thread — which is the
      // same thread Howler's html5: true HTMLAudioElement decodes audio
      // on. When the user moves the mouse / scrolls / interacts at the
      // same time, the thread saturates and the audio decoder runs out
      // of buffered samples → "broken record" stutter on output.
      // Visually, 10Hz position-bar updates are indistinguishable from
      // 60Hz to the human eye (the bar advances ~6px per tick at
      // typical widths, well under the perceptual flicker threshold).
      const now = Date.now()
      if (now - lastPositionDispatchMs >= 100) {
        const pos = positionHowl.seek() as number
        const dur = positionHowl.duration()
        dx('raf.dispatch', {
          n: rafTickCount,
          pos,
          dur,
          gap_ms: now - lastPositionDispatchMs,
          source: positionHowl === sharedHowl ? 'sharedHowl' : 'outgoingHowl',
        })
        dispatchRef.current({ type: 'SET_POSITION', position: pos })
        if (dur > 0) {
          dispatchRef.current({ type: 'SET_DURATION', duration: dur })
        }
        lastPositionDispatchMs = now
      } else if (rafTickCount % 60 === 0) {
        dx('raf.throttle-skip', {
          n: rafTickCount,
          gap_ms: now - lastPositionDispatchMs,
        })
      }

      // 4.2.12: stuck-audio watchdog DISABLED.
      // Was meant for Airfoil hijack edge cases — when Core Audio
      // renegotiated the output device, position would freeze and
      // pause/play wouldn't recover it. But the recovery path
      // (sharedHowl?.stop() + unload() + recreate) is itself
      // disruptive, and false positives — momentary buffer underruns,
      // any tick where positionHowl.seek() returned the same float
      // twice — would tear down a perfectly fine Howl and try to seek
      // back to where we "got stuck." That seek can land in the wrong
      // place, fail silently, or leave the new Howl loaded but not
      // playing. Better to let the user pause/play themselves on the
      // rare Airfoil hiccup than to have phantom kills mid-song.
      // (Refs to the watchdog state vars are kept so any other
      // surviving references keep type-checking; nothing reads them.)
      void watchdogLastObservedPos
      void watchdogLastAdvanceMs
      void watchdogLastRecoveryMs
      void watchdogRecoveryInFlight
      void WATCHDOG_STUCK_THRESHOLD_MS
      void WATCHDOG_COOLDOWN_MS
    }

    // Gapless preload + crossfade trigger only run when sharedHowl is
    // the active output (not during a crossfade tail, where sharedHowl
    // is the incoming track and its position is irrelevant for these
    // checks).
    if (sharedHowl && sharedHowl.playing() && !crossfading) {
      const pos = sharedHowl.seek() as number
      const dur = sharedHowl.duration()

      // Gapless preload: in the last ~10 seconds of the current track,
      // create a Howl for the next track. 4.5: bumped from 3s to 10s
      // so the file-decode CPU spike happens MID-tail, not in the
      // final seconds where buffer underruns produce audible cracks
      // on the still-playing current track. 10s gives the decoder
      // plenty of runway to finish well before the seam, leaving the
      // pre-warm + promote moments uncontested.
      // Skipped when crossfade is enabled (crossfade does its own
      // overlap), DJ Mode is on, repeat=one, or no next track exists.
      if (
        !crossfadeSettings.enabled &&
        !autoDjMode &&
        !gaplessNextHowl &&
        dur > 12
      ) {
        const remaining = dur - pos
        if (remaining > 0 && remaining <= 10) {
          const s = stateRef.current
          if (s.repeat !== 'one' && s.queue.length > 0) {
            // Shuffle is achieved by reordering the queue itself (see
            // TOGGLE_SHUFFLE in PlaybackContext) — playback always
            // walks the queue sequentially from queueIndex+1.
            let nextIdx = s.queueIndex + 1
            if (nextIdx >= s.queue.length) {
              nextIdx = s.repeat === 'all' ? 0 : -1
            }
            if (nextIdx >= 0) {
              const nextTrack = s.queue[nextIdx]
              if (nextTrack) {
                const { url: nextUrl, format: nextFormat } = ipodPathToAudioURL(nextTrack.path || '')
                const preload = new Howl({
                  src: [nextUrl],
                  format: [nextFormat],
                  // Same reason as the main path: Web Audio XHRs the file, and on an XHR
                  // error howler.js:2430 silently switches to html5 and EMPTIES _sounds,
                  // destroying the queued play(). This Howl gets PROMOTED into the main
                  // slot on track change, so leaving it in Web Audio kept auto-advance
                  // broken ("the next song never plays") after the main path was fixed.
                  html5: true,
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
                // 4.5.0-78 — pre-decode the same URL into a raw
                // AudioBuffer for sample-accurate seam scheduling. The
                // decode runs in parallel with Howler's own (Howler
                // shares the same fetched bytes via the browser cache).
                // Fire-and-forget; if decode fails we fall back to the
                // Howler-only path at the seam.
                if (USE_SAMPLE_ACCURATE_SEAMS) {
                  const ctx = (window as unknown as { Howler?: { ctx?: AudioContext } }).Howler?.ctx
                  if (ctx) {
                    seamIncomingBufferUrl = nextUrl
                    decodeUrl(nextUrl, ctx).then(buf => {
                      // Race guard: if user navigated away or the
                      // gapless slot got cleaned up before decode
                      // finished, drop the buffer.
                      if (seamIncomingBufferUrl === nextUrl) seamIncomingBuffer = buf
                    }).catch(() => {
                      // Decode failure: leave seamIncomingBuffer null
                      // so the seam-trigger falls back to Howler-only.
                      if (seamIncomingBufferUrl === nextUrl) {
                        seamIncomingBufferUrl = null
                        seamIncomingBuffer = null
                      }
                    })
                  }
                }
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

      // 4.5.0-71 — outgoing fade now SCHEDULED to land precisely at
      // onend, not just "triggered when remaining ≤ N." Per Grok's
      // audit on -70: rAF jitter (16–80 ms) meant the prior fixed-
      // duration fade could complete anywhere between 5 ms early and
      // 40 ms late relative to onend. Late = outgoing gain still at
      // ~0.4–0.8 at the buffer's last sample = pop on the speaker
      // cone snap to silence.
      //
      // New strategy: in rAF, when remaining ≤ 250 ms (well before the
      // seam), compute the precise moment to call Howler.fade() such
      // that the gain ramp REACHES 0 exactly at onend. Schedule it via
      // setTimeout against absolute msUntilEnd. setTimeout has 4–15 ms
      // jitter at the FIRE step, but Howler.fade itself uses Web Audio
      // gain.linearRampToValueAtTime which IS sample-accurate from the
      // fire moment forward — so a small jitter in the fire moment
      // means a small jitter in the START of the ramp, but the ramp
      // still completes deterministically (fadeDur ms later). Add a
      // 5 ms safety margin so the ramp ends just BEFORE onend in the
      // worst case.
      //
      // Also: explicitly resume the AudioContext if it got suspended
      // (e.g., the app was backgrounded). Suspended ctx means scheduled
      // gain ramps don't fire and the seam silently breaks.
      if (
        gaplessNextHowl &&
        !gaplessOutgoingFaded &&
        !crossfadeSettings.enabled
      ) {
        const remaining = dur - pos
        if (remaining > 0 && remaining * 1000 <= 250) {
          gaplessOutgoingFaded = true
          const msUntilEnd = remaining * 1000
          const ctx = (window as unknown as { Howler?: { ctx?: AudioContext } }).Howler?.ctx
          if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => { /* ignore */ })
          // 4.5.0-78 — sample-accurate fade-out via Howler's own
          // sample-accurate Web Audio gain ramp. Calling fade() with
          // duration = msUntilEnd makes the ramp END at the EXACT
          // sample-EOF (the only thing that varies is when the ramp
          // STARTS, which is now, ~250 ms before EOF). The pre-78 path
          // was: setTimeout(()=>fade(short_dur), fireDelay) where the
          // setTimeout jitter (4-15 ms) shifted the ramp's start AND
          // therefore its end relative to onend. New path: ramp starts
          // immediately, ends precisely at EOF. No setTimeout in seam
          // path = no jitter.
          if (USE_SAMPLE_ACCURATE_SEAMS && sharedHowl) {
            scheduleAbsoluteFadeOut(sharedHowl, msUntilEnd)
          } else {
            // Fallback: pre-78 behavior gated by the same flag.
            const fadeDur = Math.min(GAPLESS_FADE_OUT_DURATION_MS, Math.max(15, msUntilEnd - 5))
            const fireDelay = Math.max(0, msUntilEnd - fadeDur)
            setTimeout(() => {
              try {
                if (!sharedHowl) return
                const cur = (sharedHowl.volume() as number) || stateRef.current.volume
                sharedHowl.fade(cur, 0, fadeDur)
              } catch { /* ignore */ }
            }, fireDelay)
          }

          // 4.5.0-78 — schedule the incoming BufferSource at the EXACT
          // sample-EOF time. Bypasses Howler.play()'s "start NOW" path
          // (which carries the 3-10 ms slop that's been our incoming
          // pop source). Only fires if we successfully pre-decoded the
          // incoming buffer (Phase A); otherwise the existing onend →
          // gapless-promote path handles it the old way.
          if (
            USE_SAMPLE_ACCURATE_SEAMS &&
            ctx &&
            seamIncomingBuffer &&
            !seamStartScheduled &&
            !seamScheduled
          ) {
            seamStartScheduled = true
            const absoluteSeamTime = ctx.currentTime + msUntilEnd / 1000
            try {
              seamScheduled = scheduleAbsoluteStart(
                seamIncomingBuffer,
                ctx,
                absoluteSeamTime,
                stateRef.current.volume,
                20, // fade-in to mask buffer-start amplitude
              )
            } catch (err) {
              dx('seam.schedule-failed', { err: String(err) })
              seamStartScheduled = false
            }
          }
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
            // Shuffle is achieved by reordering the queue itself (see
            // TOGGLE_SHUFFLE in PlaybackContext) — playback always
            // walks the queue sequentially from queueIndex+1.
            let nextIdx = s.queueIndex + 1
            if (nextIdx >= s.queue.length) {
              nextIdx = s.repeat === 'all' ? 0 : -1
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

    // Reschedule rAF based on user-intent (state.isPlaying), not on
    // Howler's transient `.playing()` reports. After a programmatic
    // seek, Howler with html5: true briefly returns playing()=false
    // while the audio element re-buffers. The old gate `sharedHowl
    // .playing()` would then fail to reschedule, rAF would stop, and
    // there was no mechanism to restart it once buffering completed —
    // so the position bar froze at the seek-to spot while audio kept
    // playing past it. Trusting React state instead lets rAF tick
    // through buffering hiccups; the bar resumes the moment Howler's
    // seek() getter starts returning current values again. Crossfade
    // path keeps its own check since it has separate animation needs
    // unrelated to user playback intent.
    const stillActive =
      (sharedHowl && stateRef.current.isPlaying && !isPaused) ||
      crossfading ||
      (outgoingHowl && outgoingHowl.playing())
    if (stillActive) {
      sharedRaf = requestAnimationFrame(updatePosition)
    } else {
      // rAF death — the loop is about to stop ticking entirely. If the
      // user-perceived state is "playing" this is highly suspicious.
      dx('raf.NOT-rescheduled', {
        n: rafTickCount,
        sharedHowl: !!sharedHowl,
        isPaused,
        crossfading,
        outgoingHowl: !!outgoingHowl,
        outgoingHowl_playing: outgoingHowl?.playing() ?? null,
        react_isPlaying: stateRef.current.isPlaying,
      })
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
        // Pop suppression: don't hard-unload the previous Howl — that
        // produces an audible click when the speaker cone snaps from
        // mid-waveform amplitude straight to silence. Fade the outgoing
        // Howl to 0 over ~25ms, then unload async. The new Howl below
        // starts at vol 0 and fades in over the same window inside its
        // onplay handler — the two ramps overlap in real time, giving a
        // clean amplitude crossing through zero at the boundary.
        const departing = sharedHowl
        const curVol = (departing.volume() as number) || stateRef.current.volume
        try { departing.fade(curVol, 0, 25) } catch { /* ignore */ }
        window.setTimeout(() => {
          try { detachHowlFromEq(departing) } catch { /* ignore */ }
          try { departing.unload() } catch { /* ignore */ }
        }, 35)
        sharedHowl = null
      }
      cancelAnimationFrame(sharedRaf)
    }

    // Hover-prefetch promotion. If the user hovered this exact track
    // long enough to trigger a Web Audio prefetch (decoded into memory
    // in the background), promote it instead of constructing a fresh
    // Howl — skips the 500–1500ms HTMLAudioElement startup pipeline
    // and gives near-instant play(). Crossfade path is too entangled
    // with the construct-new-howl flow to safely promote here; falls
    // through to the standard branch.
    if (!asCrossfade && prefetchHowl && prefetchTrackId === track.id) {
      const promoted = prefetchHowl
      prefetchHowl = null
      prefetchTrackId = null
      const endedHolder = { v: false }
      const targetVol = stateRef.current.volume
      promoted.once('play', () => {
        logAudioEvent('howl.onplay', { title: track.title, src: 'prefetch-promote' })
        fadeInHowl(promoted, targetVol, 25)
        dispatchRef.current({ type: 'SET_DURATION', duration: promoted.duration() })
        sharedRaf = requestAnimationFrame(updatePosition)
      })
      promoted.once('end', () => {
        logAudioEvent('howl.onend', { title: track.title, src: 'prefetch-promote' })
        runNaturalEndRef.current?.(track, promoted, endedHolder, queueIndex)
      })
      sharedHowl = promoted
      promoted.play()
      return
    }

    const { url, format } = ipodPathToAudioURL(track.path || '')
    // Guard against the Howler 'end' event firing twice for the same
    // playback, which would cause the same track to auto-play again
    // even with repeat off. Also belt-and-suspenders loop:false so no
    // underlying <audio> element ever auto-loops.
    const endedHolder = { v: false }
    // Always start at 0 and fade in (crossfade ramps over seconds inside
    // updatePosition; non-crossfade ramps over ~25ms inside onplay). The
    // fade-in pairs with the outgoing fade-out above so neither the stop
    // nor the start lands on a non-zero waveform sample — eliminates the
    // "click" pop on song change.
    const startVolume = 0
    const howl = new Howl({
      src: [url],
      format: [format],
      // 4.5: html5:true → html5:false. PERMANENT pop fix. Streaming
      // HTMLAudioElement decoded audio on the renderer thread + read
      // bytes lazily from the protocol handler; any thread starvation
      // or disk-I/O hiccup mid-track produced a buffer underrun, which
      // is what every "random pop in the middle of a song" Jake's
      // been reporting was. Web Audio decodes the whole file into
      // memory before play() starts, then plays from buffer with
      // sample-accurate timing — no streaming pipeline that can
      // starve, no underruns possible. The gapless preload + hover
      // prefetch already use this mode; this brings the main
      // playback path in line.
      //
      // Trade-offs (already accepted elsewhere in the file):
      //   - ~30-50MB memory per loaded song. Two at a time max
      //     (current + outgoing during fade) = ~100MB. Acceptable.
      //   - First-play latency without hover prefetch: ~200-500ms for
      //     decode. Hover prefetch (60ms debounce + immediate on
      //     mousedown) covers nearly every click path; cold clicks
      //     are slightly slower but no clicks.
      //   - EQ chain bypasses (MediaElementAudioSourceNode only
      //     works with html5:true). EQ is off by default per the
      //     existing comments; if someone needs it later we wire
      //     AudioBufferSource → EQ chain instead.
      // html5, NOT Web Audio — and this reverses the 4.5 decision on purpose.
      //
      // Web Audio mode XHRs the whole file and decodes it. When that XHR
      // errors, howler.js:2430 silently switches the Howl to HTML5, EMPTIES
      // _sounds (destroying the sound our play() was queued on) and reloads.
      // The track then reports state 'loaded' with _paused true, no
      // bufferSource, no error and no playerror, and never makes a sound.
      // Measured on workmini all day: any track, at random, stuck at 0:00.
      //
      // html5 mode never XHRs, so that path cannot be entered. It also
      // streams instead of waiting for the whole file, which matters when the
      // bytes come over a link. A plain audio element on these exact URLs
      // reaches canplaythrough in ~10ms.
      //
      // The pop this replaced was a buffer underrun on a LOCAL disk read.
      // A pop is recoverable; silence is not.
      html5: true,
      loop: false,
      volume: startVolume,
      onplay: () => {
        logAudioEvent('howl.onplay', { title: track.title, url: url.slice(0, 80) })
        // EQ tap: bind the underlying HTMLAudioElement to the Web Audio
        // chain. Idempotent + a no-op when EQ is disabled. Done in onplay
        // (not after construction) because Howler's _sounds[0]._node
        // isn't populated until the element starts decoding.
        attachHowlToEq(howl)
        // Native listeners — attached on first play because the
        // _sounds[0]._node element isn't populated until decode begins.
        attachNativeListeners(howl, 'main')
        if (asCrossfade) {
          // The rAF loop is already running; updatePosition will pick
          // up this Howl on its next tick. Don't dispatch SET_DURATION
          // either — the deferred PLAY_TRACK at fade-completion will
          // dispatch it together with SET_POSITION to keep the bar
          // continuous.
          return
        }
        // Pop suppression: ramp from silent up to user volume over
        // ~25ms. Pairs with the outgoing-Howl fade-out above to avoid
        // the speaker-cone click on track change.
        fadeInHowl(howl, stateRef.current.volume, 25)
        dispatchRef.current({ type: 'SET_DURATION', duration: howl.duration() })
        dx('raf.reschedule', { site: 'howl.onplay', title: track.title, isPaused })
        sharedRaf = requestAnimationFrame(updatePosition)
      },
      onplayerror: (_id: number, err: unknown) => {
        logAudioEvent('howl.onplayerror', { err: String(err), title: track.title })
      },
      onstop: () => {
        logAudioEvent('howl.onstop', { title: track.title })
      },
      onpause: () => {
        // REMOVED in 4.0.12: the auto-resume handler that lived here was
        // calling howl.play() 200ms after every pause event. That's fine
        // for the intended Airfoil/device-switch case, but it ALSO fires
        // when the HTMLAudioElement briefly pauses because the buffer is
        // starved (mouse-move / disk hiccup / GC pause). The auto-resume
        // re-triggers buffering, which can stall again, which fires
        // another onpause, which fires another auto-resume — a feedback
        // loop that turned a minor underrun into the "broken record"
        // cascade the user reported. Logging stays so we can still see
        // the pause if it happens.
        logAudioEvent('howl.onpause', {
          title: track.title,
          isPaused_flag: isPaused,
          react_isPlaying: stateRef.current.isPlaying,
          sharedHowl_match: sharedHowl === howl,
        })
      },
      onend: () => {
        logAudioEvent('howl.onend', { title: track.title })
        // Brief 015d: capture loadAndPlay's `queueIndex` parameter into
        // this closure so runNaturalEnd uses the value that was actually
        // dispatched as PLAY_TRACK.queueIndex when this Howl was set up,
        // not whatever stateRef.current.queueIndex happens to be 75+
        // seconds later when the track ends naturally.
        runNaturalEndRef.current?.(track, howl, endedHolder, queueIndex)
      },
      onloaderror: (_id: number, err: unknown) => {
        logAudioEvent('howl.onloaderror', { err: String(err), url: url.slice(0, 80) })
        console.error('Audio load error:', err, url)
      }
    })

    sharedHowl = howl
    howl.play()

    // ── play() retry ──────────────────────────────────────────────────
    // Jake, 2026-08-10, all day: tracks that sit at 0:00, silent, at random,
    // on any song. Traced live on workmini with the player instrumented:
    //
    //   working track:  play() -> load -> play() -> EMIT play
    //   stuck track:    play() -> load -> play() -> (nothing)
    //
    // Both get the same double play() — one from here before the file has
    // loaded (Howler queues it), one when the queue drains on load. On the
    // stuck ones the second call returns normally, emits nothing, creates no
    // audio source, and reports no error. The Howl is 'loaded', _paused stays
    // true, and it sits there forever. Calling play() ONE more time by hand
    // started it immediately every time.
    //
    // So: if the sound is loaded and still not playing shortly after, ask
    // again. Guarded on sharedHowl identity so a track the user has already
    // moved past is never resurrected, and capped so a genuinely dead track
    // fails instead of looping.
    let waitTicks = 0        // ticks spent waiting for a (re)load to finish
    let playAttempts = 0     // play() calls we have actually re-issued
    const retryIfStuck = () => {
      if (sharedHowl !== howl) return          // superseded — leave it alone
      if (howl.playing()) return               // started fine
      if (howl.state() !== 'loaded') {
        // Still loading — and this is exactly the state Howler leaves the Howl
        // in when it falls back. On an XHR error it sets _html5, EMPTIES
        // _sounds (destroying the sound our play() was queued on) and calls
        // load() again. Returning here without rescheduling is why the first
        // version of this retry never fired at all. Keep waiting.
        if (waitTicks < 8) { waitTicks++; window.setTimeout(retryIfStuck, 400) }
        return
      }
      if (playAttempts >= 3) {
        logAudioEvent('howl.play.gaveup', { title: track.title, tries: playAttempts })
        return
      }
      playAttempts++
      logAudioEvent('howl.play.retry', { title: track.title, attempt: playAttempts })
      try { howl.play() } catch { /* nothing more to try */ }
      window.setTimeout(retryIfStuck, 400)
    }
    window.setTimeout(retryIfStuck, 350)
  }, [updatePosition])

  // Bind the natural-end handler to a ref so both this loadAndPlay's
  // Howl and gapless-promoted Howls (which need the same recursive
  // advance logic) can share it. Body extracted from the prior inline
  // onend so we can reuse it from the gapless promote path below.
  useEffect(() => {
    runNaturalEndRef.current = (track, howl, endedHolder, freshQueueIndex) => {
      // Brief 015c+015d: entry log captures BOTH the stateRef snapshot
      // (what the function would have used pre-015d) AND the freshly-
      // passed queueIndex (what 015d threads through the closure from
      // the promote/load site that dispatched PLAY_TRACK). If those
      // values DIFFER, stateRef was stale and 015d caught the bug.
      // Cross-reference against the most recent [dx.repeat.snapshot.
      // changed] log to triage other staleness sites.
      if (DIAGNOSTIC_LOGGING) {
        const rs = stateRef.current
        console.log('[dx.repeat.naturalEnd.enter]', {
          src: 'runNaturalEnd',
          trackBeingEnded: { id: track.id, title: track.title },
          endedHolderAlreadyV: endedHolder.v,
          howlMatchesShared: sharedHowl === howl,
          freshQueueIndex: freshQueueIndex ?? null,
          stateRefSnapshot: {
            queueIndex: rs.queueIndex,
            queueLength: rs.queue.length,
            nowPlayingId: rs.nowPlaying?.id ?? null,
            nowPlayingTitle: rs.nowPlaying?.title ?? null,
            isPlaying: rs.isPlaying,
            repeat: rs.repeat,
          },
          ts: Date.now(),
        })
      }
      if (endedHolder.v) {
        if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'endedHolder-already-v', ts: Date.now() })
        return
      }
      endedHolder.v = true
      if (sharedHowl !== howl) {
        if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'howl-not-shared', ts: Date.now() })
        return
      }
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
      window.electronAPI.recordPlay?.({ title: track.title, artist: track.artist, album: track.album, genre: track.genre, pct: 100 })

      const s = stateRef.current
      // Brief 015d: prefer the queueIndex captured at the moment the
      // onend handler was wired (passed through the closure from the
      // promote/load site that dispatched PLAY_TRACK) over
      // stateRef.current.queueIndex. stateRef freshness is tied to
      // useAudio's render cycle — long-playing tracks with no UI
      // interaction between dispatch and natural-end leave stateRef
      // pointing at a pre-dispatch snapshot. Reproduction: "Everyone
      // Has AIDS" repeated 3x on Team America soundtrack 2026-05-17
      // because s.queueIndex read 12 while the reducer state was 13.
      // s.repeat / s.queue / s.isPlaying are NOT staleness-sensitive
      // in the same way and continue to read from stateRef.
      const currentQueueIndex = freshQueueIndex ?? s.queueIndex
      // Brief 015: snapshot every state value the natural-end decision
      // reads, plus a couple of queue spot-checks (first/last titles)
      // to verify the queue is what we think it is.
      // Brief 015d: also emit `stateRefQueueIndex` alongside the
      // (now-fresh) `queueIndex` so post-fix captures show whether
      // the bug WOULD have fired and the freshQueueIndex caught it.
      if (DIAGNOSTIC_LOGGING) {
        logAudioEvent('dx.repeat.natural-end', {
          trackTitle: track.title,
          trackId: track.id,
          repeat: s.repeat,
          queueLength: s.queue.length,
          queueIndex: currentQueueIndex,
          stateRefQueueIndex: s.queueIndex,
          freshQueueIndexUsed: freshQueueIndex !== undefined,
          autoDjMode,
          isPlaying: s.isPlaying,
          firstQueueTrack: s.queue[0]?.title,
          lastQueueTrack: s.queue[s.queue.length - 1]?.title,
        })
      }
      if (s.repeat === 'one') {
        if (DIAGNOSTIC_LOGGING) {
          logAudioEvent('dx.repeat.branch.repeat-one', {
            replayingTrack: track.title,
            queueIndex: currentQueueIndex,
          })
        }
        cleanupGaplessPreload()
        loadAndPlay(track, s.queue, currentQueueIndex)
        if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'repeat-one', ts: Date.now() })
        return
      }
      // Shuffle is queue-order-baked, not per-track-random — see
      // TOGGLE_SHUFFLE in PlaybackContext. Always sequential here.
      let nextIdx = currentQueueIndex + 1
      if (nextIdx >= s.queue.length) {
        if (DIAGNOSTIC_LOGGING) {
          logAudioEvent('dx.repeat.branch.queue-exhausted', {
            nextIdx,
            queueLength: s.queue.length,
            repeat: s.repeat,
            autoDjMode,
          })
        }
        if (autoDjMode) {
          let handled = false
          const ackHandler = () => { handled = true }
          window.addEventListener('musicman-dj-set-ended-ack', ackHandler, { once: true })
          window.dispatchEvent(new Event('musicman-dj-set-ended'))
          window.removeEventListener('musicman-dj-set-ended-ack', ackHandler)
          if (handled) {
            if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'dj-set-ended-handled', ts: Date.now() })
            return
          }
          console.warn('[Audio] DJ set-ended not handled, forcing autoDjMode off')
          autoDjMode = false
        }
        if (s.repeat === 'all') nextIdx = 0
        else {
          cleanupGaplessPreload()
          dispatchRef.current({ type: 'STOP' })
          if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'stop-end-of-queue', ts: Date.now() })
          return
        }
      }
      if (DIAGNOSTIC_LOGGING) {
        // sameTrack is the smoking-gun canary: if this fires with
        // sameTrack=true, the "advance" branch is replaying the same
        // track. Brief 015d: fromIdx now reports the fresh value used
        // for the decision; stateRefFromIdx shows what stateRef would
        // have returned. If they differ but sameTrack=false → 015d
        // caught a stale read. If sameTrack=true with fresh value →
        // a different bug (real queue corruption, not staleness).
        logAudioEvent('dx.repeat.branch.advance', {
          fromIdx: currentQueueIndex,
          stateRefFromIdx: s.queueIndex,
          toIdx: nextIdx,
          fromTrack: track.title,
          toTrack: s.queue[nextIdx]?.title,
          sameTrack: s.queue[nextIdx]?.id === track.id,
        })
      }
      const nextTrack = s.queue[nextIdx]
      if (!nextTrack) {
        if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'no-next-track', nextIdx, ts: Date.now() })
        return
      }
      if (autoDjMode) {
        let handled = false
        const ackHandler = () => { handled = true }
        window.addEventListener('musicman-dj-transition-ack', ackHandler, { once: true })
        window.dispatchEvent(new CustomEvent('musicman-dj-transition', {
          detail: { prevTrack: track, nextTrack, nextIdx, queue: s.queue }
        }))
        window.removeEventListener('musicman-dj-transition-ack', ackHandler)
        if (handled) {
          if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'dj-transition-handled', ts: Date.now() })
          return
        }
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
        // Outgoing fade-to-zero is done. Clear so fadeInHowl's audible
        // snap + heartbeat can wake the incoming Howl. Leaving this true
        // was the "silent until volume nudge at every track change" bug.
        gaplessOutgoingFaded = false
        // Wire up the preloaded Howl's lifecycle (it was created without
        // these handlers in the preload step).
        const nextEndedHolder = { v: false }
        // Brief 015d: pin `ni` (the queueIndex about to be dispatched
        // for this promoted track) into the onend closure. When this
        // track ends naturally — possibly minutes later, after zero
        // intervening renders refreshed stateRef.current — runNaturalEnd
        // gets the right queueIndex via this parameter instead of the
        // stale stateRef. THIS is the confirmed Team-America-soundtrack
        // reproduction site; the other onend wiring in loadAndPlay
        // gets the same treatment for symmetry / defense in depth.
        const promotedQueueIndex = ni
        next.once('end', () => {
          runNaturalEndRef.current?.(nt, next, nextEndedHolder, promotedQueueIndex)
        })
        // REMOVED in 4.0.12: the matching auto-resume handler on the
        // gapless-promoted Howl. Same feedback-loop reason as the main
        // path. See onpause comment above.
        // Unload the just-finished Howl, promote the preload to shared.
        detachHowlFromEq(howl)
        try { howl.unload() } catch { /* ignore */ }
        sharedHowl = next
        // 4.5.0-78 — if a sample-accurate BufferSource is already
        // playing (scheduleAbsoluteStart fired in the rAF tick that
        // detected ≤250 ms remaining), the user is ALREADY hearing
        // the next track from sample 0 — Howler doesn't need to fire
        // play() at the seam, and the prewarmed-fade path would just
        // re-introduce the slop we just eliminated. Instead: promote
        // BufferSource → Howl with a contained 50 ms internal cross-
        // fade at the same audio content (the listener can't hear
        // the source-node swap because both are outputting the same
        // samples). After the crossfade, Howler owns the track for
        // the rest of its play — pause/seek/volume/EQ all work
        // normally from there. Falls through to the legacy branches
        // below when seamScheduled is null (decode failed, flag off,
        // or short-duration track that never hit the ≤250 ms window).
        if (USE_SAMPLE_ACCURATE_SEAMS && seamScheduled && seamIncomingBuffer) {
          const ctx = (window as unknown as { Howler?: { ctx?: AudioContext } }).Howler?.ctx
          const playedSec = ctx ? (ctx.currentTime - seamScheduled.scheduledStartAt) : 0
          const handle = seamScheduled
          // Reset state immediately — the rest of the seam vars are
          // captured by the promote helper via the handle.
          seamScheduled = null
          seamIncomingBuffer = null
          seamIncomingBufferUrl = null
          seamFadeOutScheduled = false
          seamStartScheduled = false
          // Seek the Howl to the spot BufferSource has played to, then
          // start at volume 0; the promote helper crossfades them.
          try { next.volume(0) } catch { /* ignore */ }
          try { next.seek(Math.max(0, playedSec)) } catch { /* ignore */ }
          const finishPromote = () => {
            attachHowlToEq(next)
            dx('raf.reschedule', { site: 'sample-accurate-promote-onplay' })
            sharedRaf = requestAnimationFrame(updatePosition)
            if (ctx) promoteBufferSourceToHowl(handle, ctx, next, 50)
          }
          // Prewarm already called play() — Howler will not emit 'play'
          // again, so waiting on once('play') leaves the Howl at volume 0
          // forever (slide-the-volume-bar to wake it).
          if (next.playing()) {
            finishPromote()
          } else {
            next.once('play', finishPromote)
            try { next.play() } catch { /* ignore */ }
          }
          const nextDur = next.duration() || 0
          dx('playtrack.dispatch', {
            site: 'sample-accurate-promote',
            title: nt.title,
            duration: nextDur,
            position: playedSec,
            sharedRaf,
            isPaused,
          })
          dispatchRef.current({ type: 'PLAY_TRACK', track: nt, queue: nq, queueIndex: ni, duration: nextDur, position: playedSec })
          if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'sample-accurate-promote', nextIdx, ts: Date.now() })
          return
        }
        if (wasPrewarmed) {
          // The preload was already started silently in the last
          // ~150ms of the previous track. Just bump the volume — it's
          // already producing audio. No play() call (which would fail
          // anyway since Howler considers the howl already playing).
          // 'play' didn't fire on the SoundManager listener path, so
          // dispatch SET_DURATION + EQ binding manually here.
          // Pop suppression: ramp 0 → target over ~25ms instead of an
          // instantaneous jump. The prewarmed howl is decoding at vol 0
          // mid-waveform; a hard volume(s.volume) flips the speaker
          // cone from silent to whatever sample is current, producing
          // the click users heard at every gapless seam.
          fadeInHowl(next, s.volume, 25)
          attachHowlToEq(next)
          // Brief 012: atomic dispatch — duration travels INSIDE the
          // PLAY_TRACK action so the reducer can't clobber it back to
          // 0 via its reset. Was the canonical 0:00 / -0:00 bug
          // reproduction site (~50% of natural autoplay transitions).
          dx('playtrack.dispatch', {
            site: 'gapless-prewarm',
            title: nt.title,
            duration: next.duration(),
            position: 0,
            sharedRaf,
            isPaused,
            sharedHowl_playing: next.playing(),
          })
          dispatchRef.current({ type: 'PLAY_TRACK', track: nt, queue: nq, queueIndex: ni, duration: next.duration(), position: 0 })
          // Brief 012d: previous code was `if (!sharedRaf) sharedRaf = ...`
          // which silently failed because sharedRaf still holds the prior
          // track's pending handle. That pending tick fires once on the new
          // track's context, stillActive returns false, the loop exits
          // without rescheduling, and SET_POSITION dispatches stop forever
          // until the next transition restarts rAF. Always cancel and
          // re-arm — same pattern used by standard promote and initial
          // creation sites.
          dx('raf.gapless-prewarm-rearm', { site: 'gapless-prewarm', oldSharedRaf: sharedRaf })
          cancelAnimationFrame(sharedRaf)
          sharedRaf = requestAnimationFrame(updatePosition)
        } else {
          // 4.5.0-70: 5 ms fade-in (was -65 default) was effectively a
          // step function — any track whose first sample has non-zero
          // amplitude (most music) clicked. 20 ms is short enough to
          // not register as a perceived "fade" but long enough for the
          // ear to read the onset as smooth. See block comment near
          // GAPLESS_FADE_IN_MS for the full rationale.
          next.once('play', () => {
            attachHowlToEq(next)
            dx('raf.reschedule', { site: 'standard-promote-onplay' })
            sharedRaf = requestAnimationFrame(updatePosition)
          })
          try { next.volume(0) } catch { /* ignore */ }
          next.play()
          fadeInHowl(next, s.volume, GAPLESS_FADE_IN_MS)
          // Brief 012: pass duration through PLAY_TRACK atomically.
          // If the howl isn't fully loaded here next.duration() may
          // return 0 — the load-handler SET_DURATION around line 600
          // is the fallback for that case.
          const nextDur = next.duration() || 0
          dx('playtrack.dispatch', {
            site: 'standard-promote',
            title: nt.title,
            duration: nextDur,
            position: 0,
            sharedRaf,
            isPaused,
          })
          dispatchRef.current({ type: 'PLAY_TRACK', track: nt, queue: nq, queueIndex: ni, duration: nextDur, position: 0 })
        }
        if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'gapless-promote', nextIdx, ts: Date.now() })
        return
      }

      // Standard advance — preload didn't match (or wasn't ready).
      cleanupGaplessPreload()
      dx('playtrack.dispatch', {
        site: 'standard-advance',
        title: nextTrack.title,
        sharedRaf,
        isPaused,
      })
      dispatchRef.current({ type: 'PLAY_TRACK', track: nextTrack, queue: s.queue, queueIndex: nextIdx, duration: (nextTrack.duration || 0) / 1000 })
      loadAndPlay(nextTrack, s.queue, nextIdx)
      if (DIAGNOSTIC_LOGGING) console.log('[dx.repeat.naturalEnd.exit]', { src: 'runNaturalEnd', branch: 'standard-advance', nextIdx, ts: Date.now() })
    }
  }, [loadAndPlay, updatePosition])

  // Bind the crossfade-start callable to the ref so updatePosition can
  // reach it without forming a circular useCallback dep cycle.
  useEffect(() => {
    startCrossfadeRef.current = (track, queue, queueIndex) => {
      loadAndPlay(track, queue, queueIndex, true)
    }
  }, [loadAndPlay])

  const playTrack = useCallback((track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean) => {
    if (autoDjMode && !djTransition) {
      window.dispatchEvent(new Event('musicman-dj-cancel'))
    }
    const q = queue ?? stateRef.current.queue
    const qi = queueIndex ?? 0
    dx('playtrack.dispatch', {
      site: 'manual',
      title: track.title,
      sharedRaf,
      isPaused,
      djTransition: !!djTransition,
      freshContext: !!freshContext,
    })
    // Brief 030c: pass freshContext through. View-side callers
    // (SongsView, Toolbar Shuffle All, etc.) pass true. nextTrack/
    // prevTrack pass false (default) — they're queue navigation,
    // and the reducer must NOT rebuild the shuffle queue on those
    // dispatches or queueIndex resets to 0 every Next press.
    //
    // Seed duration from the track metadata so the pill renders
    // "0:00 / 3:42" immediately on click instead of "0:00 / -0:00"
    // while the Howl decodes — the metadata-derived value matches
    // what howl.duration() will report a moment later, and the
    // onplay SET_DURATION reconciles any sub-second drift. Removes
    // the "song takes 2 seconds to load" perceptual lag even though
    // the audio start time is unchanged.
    dispatchRef.current({
      type: 'PLAY_TRACK',
      track,
      queue: q,
      queueIndex: qi,
      freshContext,
      duration: (track.duration || 0) / 1000,
    })
    loadAndPlay(track, q, qi)
  }, [loadAndPlay])

  // Wire the ref so updatePosition's stuck-audio watchdog can call
  // playTrack to rebuild the broken Howl. Has to be a ref because
  // updatePosition is defined long before playTrack.
  useEffect(() => {
    playTrackRef.current = playTrack
  }, [playTrack])

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
    // pct = exactly how far in (25%? 50%? 75%?) — richer than the binary skip flag.
    if (s.nowPlaying && s.duration > 0) {
      const completionFrac = s.position / s.duration
      if (completionFrac < 0.8) {
        window.electronAPI.recordSkip?.({ title: s.nowPlaying.title, artist: s.nowPlaying.artist, pct: Math.round(completionFrac * 100) })
      }
    }
    // 4.0 background signal: per-track skipCount on sub-30s bail. Stronger
    // negative signal than the 80% gate; feeds recommendation filtering.
    if (s.nowPlaying && s.position < 30) {
      const ct = s.nowPlaying
      const latest = tracksRef.current.find(tr => tr.id === ct.id)
      const newCount = (Number(latest?.skipCount ?? ct.skipCount) || 0) + 1
      const skipFp = `${(ct.title || '').toLowerCase().trim()}|${(ct.artist || '').toLowerCase().trim()}|${ct.duration || 0}`
      window.electronAPI.saveMetadataOverride(ct.id, 'skipCount', String(newCount), skipFp)
    }
    // Shuffle bakes randomness into queue order; manual next/prev
    // walks the queue sequentially. (TOGGLE_SHUFFLE shuffles the
    // upcoming queue when turning on.)
    let nextIdx = s.queueIndex + 1
    if (nextIdx >= s.queue.length) {
      if (s.repeat === 'all') nextIdx = 0
      else return
    }
    const track = s.queue[nextIdx]
    if (track) playTrack(track, s.queue, nextIdx)
  }, [playTrack])

  const prevTrack = useCallback(() => {
    const s = stateRef.current
    if (s.queue.length === 0) return
    // Brief 030c: 3-second-guard removed. Previous always navigates
    // to the previous track. Restart-current-song UX moved to the
    // progress bar (seek to 0); two controls, two actions.
    // In shuffle mode, go back through shuffle history
    if (s.shuffle && s.shuffleHistory.length > 0) {
      const history = [...s.shuffleHistory]
      const prevIdx = history.pop()!
      dispatchRef.current({ type: 'SET_SHUFFLE_HISTORY', history })
      const track = s.queue[prevIdx]
      if (track) {
        dx('playtrack.dispatch', {
          site: 'prev-shuffle',
          title: track.title,
          sharedRaf,
          isPaused,
        })
        dispatchRef.current({ type: 'PLAY_TRACK', track, queue: s.queue, queueIndex: prevIdx, skipHistory: true, duration: (track.duration || 0) / 1000 })
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
      // Invalidate the throttle gate so the very next rAF tick
      // dispatches the actual current position, not the user's
      // drag-to value. Otherwise the bar can sit at the drag-to
      // value for up to 100ms while the gate re-opens. Sub-perceptual
      // gap usually but worth the one extra dispatch.
      dx('throttle.reset', { site: 'seek', pos })
      lastPositionDispatchMs = 0
    }
  }, [])

  const setVolume = useCallback((v: number) => {
    resumeEqContext()
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
