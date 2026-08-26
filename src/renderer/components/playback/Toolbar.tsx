import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio, setAutoDjMode } from '../../hooks/useAudio'
import { attachClipToBroadcast, attachAnnouncerToBroadcast, detachClipFromBroadcast, startRecording, stopRecording } from '../../audio/eq'
import { playStinger, randomPreStinger, randomEndStinger, STINGER_DURATIONS } from '../../audio/stingers'
import { RadioEngine, type SegmentRequest } from '../../radio/RadioEngine'
import TransportControls from './TransportControls'
import NowPlaying from './NowPlaying'
import VolumeSlider from './VolumeSlider'
import SearchPill from './SearchPill'
import { setNotice, setBroadcast, streamBroadcast, setBroadcastTimed, setRadio, getBroadcast } from '../../activity'

// 4.5 radioV2 rebuild — when true, Radio Mode routes through the new RadioEngine
// (src/renderer/radio/); false = the original V1 path. Lets us A/B the two.
const RADIO_V2 = true

type Trackish = { title?: string; artist?: string; album?: string; genre?: string; year?: string | number }
type SlotParams = { useAnnouncer?: boolean; callerSegment?: boolean; djHandsSegment?: boolean; callerId?: string; archetypeId?: string; slot?: number; hourCounter?: number; miniId?: boolean }

/** Map a (prev, next, slot-params) triple to a RadioEngine SegmentRequest. */
function buildSegmentReq(prev: Trackish, next: Trackish | undefined, params: SlotParams): SegmentRequest {
  const meta = (t?: Trackish) => ({ title: t?.title || '', artist: t?.artist || '', album: t?.album || '', genre: t?.genre || '', year: t?.year ?? '' })
  return {
    track: meta(prev),
    nextTrack: next ? meta(next) : undefined,
    forceAnnouncer: params.useAnnouncer,
    callerSegment: params.callerSegment,
    djHandsSegment: params.djHandsSegment,
    callerId: params.callerId,
    archetypeId: params.archetypeId,
    slot: params.slot,
    hourCounter: params.hourCounter,
    miniId: params.miniId,
  }
}

function QueueIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 5h12" />
      <path d="M2 10h12" />
      <path d="M2 15h7" />
      <path d="M15 11v6" />
      <path d="M12 14h6" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="7" y="2" width="6" height="9" rx="3" />
      <path d="M4 10a6 6 0 0012 0" />
      <path d="M10 16v3M7 19h6" />
    </svg>
  )
}

function RadioIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 5v12" strokeWidth="1.8" />
      <path d="M10 17L6 19M10 17L14 19" />
      <path d="M8 10h4" />
      <path d="M9 13h2" />
      <path d="M10 7L7 17" strokeWidth="1" />
      <path d="M10 7L13 17" strokeWidth="1" />
      <path d="M7 4.5a4 4 0 016 0" strokeWidth="1.3" />
      <path d="M5 2.5a7 7 0 0110 0" strokeWidth="1.2" />
      <circle cx="10" cy="4.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Record button glyph — a solid circle (canonical "record" symbol). When
// active, the CSS pulses it red.
function RecordIcon({ active }: { active?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="6" fill={active ? '#ff3b3b' : 'currentColor'} />
      {active && <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />}
    </svg>
  )
}

function AirPlayIcon({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2h14a1 1 0 011 1v9a1 1 0 01-1 1h-3" />
      <path d="M6 13H3a1 1 0 01-1-1V3a1 1 0 011-1" />
      <polygon points="10,11 6,18 14,18" fill={active ? 'currentColor' : 'none'} strokeWidth="1.5" />
    </svg>
  )
}

// 4.4.52: who the toolbar speech bubble can attribute. The mic button
// speaks as the chosen host (Music Man or Megan); DJ Mode is Stephen
// Hands. Each gets its own name, loading verb, and (via the matching
// `data-speaker` attribute → toolbar.css) its own colour palette.
type BubbleSpeaker = 'mm' | 'megan' | 'djhands'
const BUBBLE_SPEAKER_LABEL: Record<BubbleSpeaker, string> = {
  mm: 'The Music Man',
  megan: 'Megan',
  djhands: 'Stephen Hands',
}
const BUBBLE_SPEAKER_VERB: Record<BubbleSpeaker, string> = {
  mm: 'is listening',
  megan: 'is weighing in',
  djhands: 'is on the decks',
}

export default function Toolbar({ onToggleQueue, onOpenQueue, showQueue }: { onToggleQueue: () => void; onOpenQueue: () => void; showQueue: boolean }) {
  const { state: pb } = usePlayback()
  const { state: lib } = useLibrary()
  const { setVolume, playTrack, stopPlayback } = useAudio()
  const [autoDj, setAutoDj] = useState(false)
  // 4.1.6: Radio Mode — continuous WJLR-style commentary between tracks.
  // Distinct from `autoDj` which is only on during a Music-Man-curated
  // DJ Set. Radio Mode rides whatever queue the user picked. Mutually
  // exclusive with autoDj at the UI level (toggling one off the other).
  const [radioMode, setRadioMode] = useState(false)
  // 4.4.3: Radio Mode is capped at 90 minutes per session. Real FM
  // shows have a runtime; an unbounded radio session loses its sense of
  // pacing and burns through tokens. Visible elapsed-time pill counts
  // up next to ON AIR so the listener sees how much air-time is left.
  const RADIO_CAP_MS = 90 * 60 * 1000
  const [radioElapsedMs, setRadioElapsedMs] = useState(0)
  const radioStartedAtRef = useRef(0)
  const radioTickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const radioCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const radioEngineRef = useRef<RadioEngine | null>(null)  // 4.5 radioV2 engine
  // 4.2.20: recording state — captures the broadcast (music + TTS routed
  // through the AudioContext via attachClipToBroadcast) into a single
  // audio file. Click Record to start, click again to stop. On stop we
  // hand the blob to main for ffmpeg → MP3 + native save dialog.
  const [recording, setRecording] = useState(false)
  const [recElapsed, setRecElapsed] = useState(0)
  const recElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recStartedAtRef = useRef(0)
  // Cache for pre-fetched radio commentary. Stores an ARRAY of dialog
  // segments — each line gets its own TTS audio because we use three
  // distinct ElevenLabs voices: The Music Man, Megan (co-host), and
  // a deeper "Announcer" voice for the campy WJLR station ID drops.
  type RadioSpeaker =
    | 'mm' | 'megan' | 'announcer' | 'djhands'
    // Callers (the 9-person rolodex):
    | 'giovanni' | 'rajiv' | 'bernard' | 'lashonte' | 'kristina'
    | 'devin' | 'maya' | 'mike' | 'zoe'
  type RadioSegment = { speaker: RadioSpeaker; line: string; audioData: string }
  const radioCacheRef = useRef<Map<string, { segments: RadioSegment[]; fullText: string }>>(new Map())
  // 4.2.7: deterministic announcer scheduling. The opener always has
  // an [ANNOUNCER] drop; between-track transitions get one every 4th
  // transition (predictable cadence — roughly one drop every 4 songs
  // after the opener). Counter is reset when Radio Mode toggles off.
  const radioTransitionCounterRef = useRef<number>(0)
  const radioPrefetchedKeyRef = useRef<string | null>(null)
  // Guard against overlapping transition handlers (double onend → double banter).
  const radioTransitionBusyRef = useRef(false)
  // Tracks which cacheKey is currently being prefetched so we don't stampede.
  const radioPrefetchInFlightRef = useRef<string | null>(null)
  // Slot params (incl. callerId) pinned at prefetch time so live-fetch
  // matches what Claude was asked for when the cache misses.
  const radioTransitionParamsRef = useRef<Map<string, {
    slot: number; hourCounter: number; useAnnouncer: boolean; miniId: boolean
    callerSegment: boolean; djHandsSegment: boolean; archetypeId?: string; callerId?: string
  }>>(new Map())
  const [djActive, setDjActive] = useState(false)
  const [djText, setDjText] = useState('')
  const [djLoading, setDjLoading] = useState(false)
  const [showBubble, setShowBubble] = useState(true)
  // 4.4.49: who the speech bubble is currently attributing. The mic
  // button is the chosen host (Music Man or Megan — 4.4.52); DJ Mode
  // is Stephen Hands. Was hardcoded to "The Music Man" — so DJ Mode
  // commentary showed up under the wrong name. The bubble label, the
  // loading verb, and the colour palette all read from this.
  const [djSpeaker, setDjSpeaker] = useState<BubbleSpeaker>('mm')
  const [djExiting, setDjExiting] = useState(false)
  const savedVolumeRef = useRef(0.8)
  const djAudioRef = useRef<HTMLAudioElement | null>(null)
  // 4.5: hover-prefetch debounce. Mouse-over the mic button → after
  // ~200ms (long enough to not fire on accidental sweeps) kick off the
  // artist-facts lookup so a real click finds the cache already warm.
  const micHoverTimer = useRef<number | null>(null)
  const lastPrefetchedTrackId = useRef<number | null>(null)

  // The active volume fade lives in a ref so cancel/restore paths can stop
  // it — a local setInterval (the old code) kept ramping after a cancel
  // restored the volume, yanking it back (CLAUDE.md cancel-reverses-start).
  // clearFade also resolves any pending fadeVolumeOut promise so an awaiter
  // (handleStart) can't dangle when a fade is cancelled mid-flight.
  const fadeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fadeResolveRef = useRef<(() => void) | null>(null)
  const clearFade = useCallback(() => {
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current)
      fadeIntervalRef.current = null
    }
    if (fadeResolveRef.current) {
      fadeResolveRef.current()
      fadeResolveRef.current = null
    }
  }, [])

  const fadeVolumeIn = useCallback(() => {
    clearFade() // cancel any in-flight fade so they can't fight over volume
    const target = savedVolumeRef.current
    const start = target * 0.15
    let step = 0
    fadeIntervalRef.current = setInterval(() => {
      step++
      if (step >= 30) {
        setVolume(target)
        clearFade()
      } else {
        setVolume(start + (target - start) * (step / 30))
      }
    }, 50)
  }, [setVolume, clearFade])

  const fadeVolumeOut = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      clearFade()
      fadeResolveRef.current = resolve
      const start = savedVolumeRef.current
      const target = start * 0.15
      let step = 0
      fadeIntervalRef.current = setInterval(() => {
        step++
        if (step >= 20) {
          setVolume(target)
          clearFade() // clears the interval AND resolves via fadeResolveRef
        } else {
          setVolume(start - (start - target) * (step / 20))
        }
      }, 50)
    })
  }, [setVolume, clearFade])

  // Global fade for any Music Man speech (MusicManView, SmartPlaylistView, etc.)
  const isFadedRef = useRef(false)
  useEffect(() => {
    const handleStart = async () => {
      if (isFadedRef.current) return
      isFadedRef.current = true
      savedVolumeRef.current = pb.volume
      await fadeVolumeOut()
      window.dispatchEvent(new Event('musicman-fade-ready'))
    }
    const handleEnd = () => {
      if (!isFadedRef.current) return
      isFadedRef.current = false
      fadeVolumeIn()
    }
    window.addEventListener('musicman-speaking-start', handleStart)
    window.addEventListener('musicman-speaking-end', handleEnd)
    return () => {
      window.removeEventListener('musicman-speaking-start', handleStart)
      window.removeEventListener('musicman-speaking-end', handleEnd)
    }
  }, [pb.volume, fadeVolumeOut, fadeVolumeIn])

  // 4.5.2: relay djText / djLoading into the activity store's broadcast
  // mode so the now-playing pill renders the caption with a typewriter
  // reveal — replaces the floating dj-bubble (the bubble JSX below is
  // gone). One effect, no per-callsite changes; every existing setDjText
  // call flows through here.
  useEffect(() => {
    // 4.5: In Radio Mode the radio-segment path (playSingleRadioSegment →
    // setBroadcastTimed) is the SOLE owner of the pill's caption + speaker.
    // This legacy DJ-bubble relay must NOT also write here during radio — the
    // radio path calls setDjText(caption) (Toolbar ~757) which fires THIS effect,
    // and with djSpeaker pinned to 'djhands' at the transition (~1083) it relabels
    // every radio caption BUBBLE_SPEAKER_LABEL['djhands'] = "Stephen Hands",
    // clobbering the correct per-host label. (The "Stephen Hands is speaking but
    // it isn't" bug.) Radio owns the pill; the DJ-bubble stays out of its lane.
    if (radioMode) return
    if (djLoading) {
      setBroadcast({ speaker: BUBBLE_SPEAKER_LABEL[djSpeaker], text: '', mode: 'thinking' })
    } else if (djText) {
      // 4.5: the mic-button path drives setBroadcastTimed directly so
      // the typewriter is pinned to the audio's exact duration. If the
      // activity store ALREADY shows this exact speaker+text+speaking
      // state, the timed reveal is already running — don't fire the
      // generic 12 cps setBroadcast on top (it would reset reveal to
      // 0 and run at the wrong rate). Only fall back to setBroadcast
      // for paths that didn't pre-set (radio segments, etc.).
      const speaker = BUBBLE_SPEAKER_LABEL[djSpeaker]
      const current = getBroadcast()
      if (current?.mode === 'speaking' && current.text === djText && current.speaker === speaker) return
      setBroadcast({ speaker, text: djText, mode: 'speaking' })
    } else if (!djActive) {
      // Speech finished — dismiss the now-playing caption. (An older
      // guard blocked clear whenever mode==='speaking', which left the
      // pill frozen on the last karaoke-highlighted word forever.)
      setBroadcast(null)
    }
  }, [djText, djLoading, djSpeaker, djActive, radioMode])

  // Cancel DJ when user manually plays a track
  useEffect(() => {
    const handler = () => {
      djCancelledRef.current = true
      // 4.4.14: invalidate any in-flight startDjSet run so a stale
      // IPC response can't proceed after cancel.
      djModeGenerationRef.current += 1
      setAutoDjMode(false) // immediately clear module-level flag
      if (djAudioRef.current) {
        // 4.4.14: disconnect the broadcast source BEFORE nulling.
        // pause() doesn't fire 'ended', so attachClipToBroadcast's
        // cleanup never runs — the source node stays summed into
        // preamp and accumulates over a session (4.4.6 rattle class).
        detachClipFromBroadcast(djAudioRef.current)
        djAudioRef.current.pause()
        djAudioRef.current = null
        clearFade() // stop any in-flight duck fade before restoring volume
        isFadedRef.current = false // clear the latch so the next speech re-ducks
        setVolume(savedVolumeRef.current)
      }
      setAutoDj(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      setDjModeActive(false)
      setDjModeTheme('')
    }
    window.addEventListener('musicman-dj-cancel', handler)
    return () => window.removeEventListener('musicman-dj-cancel', handler)
  }, [setVolume, clearFade])

  // Sync auto-DJ mode to audio module. Either DJ-Set's autoDj OR the
  // user-toggled Radio Mode triggers the between-track event the
  // transition handler listens on.
  useEffect(() => {
    setAutoDjMode(autoDj || radioMode)
  }, [autoDj, radioMode])

  // 4.5: push radio status into the activity store so NowPlaying paints
  // the "ON AIR · WJLR 330.9 · elapsed / remaining" strip INSIDE the
  // pill. Removes the awkward external red pill that used to sit next
  // to the transport row (Jake: "it needs to make sense"). Tick-level
  // updates are coalesced inside setRadio so repeated equal-state pushes
  // are cheap.
  useEffect(() => {
    if (radioMode) {
      setRadio({ active: true, elapsedMs: radioElapsedMs, capMs: RADIO_CAP_MS })
    } else {
      setRadio(null)
    }
  }, [radioMode, radioElapsedMs, RADIO_CAP_MS])

  // Toggle handler for Radio Mode — mutual exclusion with autoDj.
  // Turning ON shuffles the entire library, generates a SHOW OPENER
  // (campy [ANNOUNCER] station ID + MM/Megan welcome banter), plays
  // it through, THEN starts the first track. Without the opener, the
  // user just heard music start with no station ID — defeating the
  // "WJLR coming on the air" feel.
  // 4.2.20: Record button handler — toggles recording. On stop, asks
  // main to write blob → MP3 (via ffmpeg) at a user-chosen path.
  const handleRecordToggle = useCallback(async () => {
    if (recording) {
      // Stop. Pause the elapsed timer immediately so the UI returns
      // before the (potentially several-second) MP3 transcode runs.
      setRecording(false)
      if (recElapsedTimerRef.current) {
        clearInterval(recElapsedTimerRef.current)
        recElapsedTimerRef.current = null
      }
      const result = await stopRecording()
      if (!result.ok || !result.blob) {
        console.warn('[Record] stop failed:', result.error)
        return
      }
      const arrayBuffer = await result.blob.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      const saveResult = await window.electronAPI.saveRecordingMp3(bytes, result.mimeType || 'audio/webm')
      if (saveResult.ok) {
        console.log('[Record] saved to', saveResult.path)
      } else {
        console.warn('[Record] save failed:', saveResult.error)
      }
    } else {
      // Start.
      const result = startRecording()
      if (!result.ok) {
        console.warn('[Record] start failed:', result.error)
        return
      }
      setRecording(true)
      recStartedAtRef.current = Date.now()
      setRecElapsed(0)
      recElapsedTimerRef.current = setInterval(() => {
        setRecElapsed(Math.floor((Date.now() - recStartedAtRef.current) / 1000))
      }, 1000)
    }
  }, [recording])

  const handleRadioToggle = useCallback(async () => {
    if (radioMode) {
      // OFF — clear caches, counters, and the cap timer.
      setRadioMode(false)
      radioEngineRef.current?.stop()
      radioCacheRef.current.clear()
      radioPrefetchedKeyRef.current = null
      radioTransitionParamsRef.current.clear()
      radioTransitionCounterRef.current = 0
      if (radioTickIntervalRef.current) { clearInterval(radioTickIntervalRef.current); radioTickIntervalRef.current = null }
      if (radioCapTimerRef.current) { clearTimeout(radioCapTimerRef.current); radioCapTimerRef.current = null }
      setRadioElapsedMs(0)
      // 4.5: drop the persisted show plan so it doesn't leak into the
      // next session's segments. Fire-and-forget.
      void window.electronAPI.radioClearShowPlan?.()
      return
    }
    setAutoDj(false)
    const tracks = lib.tracks
    if (tracks.length === 0) return

    // 4.5: ask the hosts to PLAN the show before playback starts.
    // Pre-4.5 the queue was just `[...tracks].sort(random)` → genre
    // whiplash that read as "no plan" (Jake's words: "too jumpy with
    // genres"). The planner builds a curated 13-track set with a theme
    // + throughline, then we ride that as the queue. Falls back to
    // shuffle if the planner times out or errors so the user never
    // gets stuck on a dead Radio button.
    // 4.5: cap the planner's track payload at 600 randomly-sampled
    // tracks. Pre-cap, the full library (often 6000+ tracks) hit
    // Claude as a ~500KB prompt — adds 2-4s on its own. 600 is enough
    // for the planner to feel the shape of the collection without
    // shipping the whole thing every Radio toggle.
    const PLAN_TRACK_CAP = 600
    const tracksForPlanner = tracks.length > PLAN_TRACK_CAP
      ? [...tracks].sort(() => Math.random() - 0.5).slice(0, PLAN_TRACK_CAP)
      : tracks
    const planCompactTracks = tracksForPlanner.map(t => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      genre: t.genre, year: t.year,
      playCount: Number(t.playCount) || 0,
      rating: Number(t.rating) || 0,
      lastPlayedAt: t.lastPlayedAt || 0,
      dateAdded: t.dateAdded || '',
    }))
    const recentIds = pb.recentlyPlayed || []
    let shuffled: typeof tracks
    let showTheme: string | undefined
    try {
      // 4.5: planner timeout dropped 8s → 3s. Pre-cut the toggle felt
      // dead for up to 23s in the worst case (8s planner + 15s opener).
      // 3s either lands a plan or we degrade to shuffle without making
      // the user stare at a non-responsive button.
      const planPromise = window.electronAPI.musicmanRadioPlan(planCompactTracks, recentIds)
      const timeout = new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 3000))
      const result = await Promise.race([planPromise, timeout])
      if (result.ok && 'trackIds' in result && Array.isArray(result.trackIds) && result.trackIds.length > 0) {
        const byId = new Map(tracks.map(t => [t.id, t]))
        const planTracks = result.trackIds.map(id => byId.get(id)).filter((t): t is typeof tracks[number] => !!t)
        if (planTracks.length >= 5) {
          shuffled = planTracks
          showTheme = result.theme
          console.log(`[Radio] planner: "${result.theme}" — ${planTracks.length} tracks`)
          // 4.5: push the plan to main-side radio-memory so every per-
          // segment musicman-radio call can inject theme + throughline
          // + "track N of M" into the hosts' prompt. Fire-and-forget;
          // a persistence failure doesn't block playback.
          if ('theme' in result && 'throughline' in result && result.theme && result.throughline) {
            void window.electronAPI.radioSetShowPlan?.({
              theme: result.theme,
              throughline: result.throughline,
              setList: planTracks.map(t => ({ id: t.id, title: t.title || '', artist: t.artist || '' })),
            })
          }
        } else {
          console.warn(`[Radio] planner returned too few resolvable tracks (${planTracks.length}); falling back to shuffle`)
          shuffled = [...tracks].sort(() => Math.random() - 0.5)
        }
      } else {
        console.warn('[Radio] planner failed, falling back to shuffle:', result)
        shuffled = [...tracks].sort(() => Math.random() - 0.5)
      }
    } catch (err) {
      console.warn('[Radio] planner threw, falling back to shuffle:', err)
      shuffled = [...tracks].sort(() => Math.random() - 0.5)
    }

    const firstTrack = shuffled[0]
    setRadioMode(true)
    stopPlayback()
    if (showTheme) console.log(`[Radio] tonight's theme: ${showTheme}`)
    // 4.4.3: arm the 90-min cap. After RADIO_CAP_MS the show wraps —
    // the toggle flips back to OFF as if the user clicked it. Tick
    // updates radioElapsedMs every second so the pill counts up.
    radioStartedAtRef.current = Date.now()
    setRadioElapsedMs(0)
    if (radioTickIntervalRef.current) clearInterval(radioTickIntervalRef.current)
    radioTickIntervalRef.current = setInterval(() => {
      setRadioElapsedMs(Date.now() - radioStartedAtRef.current)
    }, 1000)
    if (radioCapTimerRef.current) clearTimeout(radioCapTimerRef.current)
    radioCapTimerRef.current = setTimeout(() => {
      console.log('[Radio] 90-minute cap reached — signing off.')
      // Trigger the same teardown the OFF branch above runs. Calling
      // setRadioMode(false) flips the React state; the cleanup
      // useEffect handles the rest. Manually clear the timer/interval
      // so they don't double-fire if the user toggles fast after.
      setRadioMode(false)
      radioEngineRef.current?.stop()
      radioCacheRef.current.clear()
      radioPrefetchedKeyRef.current = null
      radioTransitionCounterRef.current = 0
      if (radioTickIntervalRef.current) { clearInterval(radioTickIntervalRef.current); radioTickIntervalRef.current = null }
      radioCapTimerRef.current = null
      setRadioElapsedMs(0)
      void window.electronAPI.radioClearShowPlan?.()
    }, RADIO_CAP_MS)
    console.log('[Radio] toggle ON — generating opener…')

    if (RADIO_V2) {
      try {
        const engine = await ensureRadioEngine()
        setDjActive(true)
        setDjLoading(true)
        await engine.playOpener(buildSegmentReq({}, firstTrack, { useAnnouncer: true, slot: 0, hourCounter: 0 }))
      } catch (err) {
        console.warn('[radioV2] opener threw, starting track directly:', err)
      }
    } else {
    // Timeout applies only to Claude fetch — never cut off mid-playback.
    const OPENER_FETCH_TIMEOUT_MS = 20000
    try {
      const fetchPromise = window.electronAPI.musicmanRadio(
        { title: '', artist: '', album: '', genre: '', year: '' },
        { title: firstTrack.title || '', artist: firstTrack.artist || '', album: firstTrack.album || '', genre: firstTrack.genre || '', year: firstTrack.year || '' },
        true,
        true,
      )
      const timeout = new Promise<{ ok: false }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), OPENER_FETCH_TIMEOUT_MS)
      })
      const r = await Promise.race([fetchPromise, timeout])
      console.log('[Radio] musicmanRadio returned ok=' + r.ok + ' text-length=' + ('text' in r ? r.text?.length ?? 0 : 0))
      if (r.ok && 'text' in r && r.text) {
        console.log('[Radio] OPENER FULL TEXT:\n' + r.text)
        setDjActive(true)
        setDjLoading(true)
        const segments = await synthesizeRadioSegments(r.text)
        console.log('[Radio] got ' + segments.length + ' opener segments')
        if (segments.length > 0) {
          setDjLoading(false)
          await playRadioSegmentSequence(segments)
        }
      } else if (!r.ok) {
        console.warn('[Radio] opener fetch timed out or failed — starting track')
      }
    } catch (err) {
      console.warn('[Radio] opener flow threw, starting track directly:', err)
    }
    }
    djAudioRef.current = null
    setDjActive(false)
    setDjLoading(false)
    console.log('[Radio] starting first track:', firstTrack.title)
    // 4.2.15 critical bug fix: pass djTransition=TRUE here. Without it,
    // playTrack sees `autoDjMode && !djTransition` and dispatches
    // `musicman-dj-cancel`, which calls setAutoDjMode(false) directly.
    // That flips the module-level flag off PERMANENTLY for this radio
    // session — runNaturalEnd's `if (autoDjMode)` branch now reads false
    // every time a song ends, so the dj-transition event never fires
    // and MM/Megan never come back between songs. The user reported
    // exactly this: "they speak once and then they don't come in and
    // out." This is the kick that started turning the radio off.
    playTrack(firstTrack, shuffled, 0, true, true)
  }, [radioMode, lib.tracks, playTrack, stopPlayback])

  // "Start Artist Radio" — dispatched from any view's right-click menu
  // (initially SongsView, expandable to Albums/Artists/Genres later).
  // Filters the library to that artist, shuffles, sets queue, turns
  // Radio Mode on. Same flow as the default toggle but with a focused
  // track set instead of the whole library.
  useEffect(() => {
    const handler = (e: Event) => {
      const { tracks } = (e as CustomEvent).detail as { tracks: typeof lib.tracks; label?: string }
      if (!tracks || tracks.length === 0) return
      const shuffled = [...tracks].sort(() => Math.random() - 0.5)
      playTrack(shuffled[0], shuffled, 0, false, true)
      setAutoDj(false)
      setRadioMode(true)
      radioCacheRef.current.clear()
      radioPrefetchedKeyRef.current = null
    }
    window.addEventListener('jaketunes-start-artist-radio', handler)
    return () => window.removeEventListener('jaketunes-start-artist-radio', handler)
  }, [playTrack])

  // Voice IDs for the three Radio Mode speakers. The Music Man falls
  // through to the server-side env override (or default) when voiceId
  // is undefined, so we only pass IDs explicitly for Megan and the
  // Announcer.
  const MEGAN_VOICE_ID = 'T7eLpgAAhoXHlrNajG8v'
  const ANNOUNCER_VOICE_ID = 'CeNX9CMwmxDxUF5Q2Inm'
  // 4.4.0: caller rolodex — 9 distinct caller voices, each occupying a
  // different conversational function so callbacks don't collapse into
  // "Giovanni again." Server-side cast bible in src/main/cast.ts.
  const GIOVANNI_VOICE_ID = 'UOB3uZCEf2cjGpZaGOXq'
  const RAJIV_VOICE_ID    = 'miqykcv8BCUvQnRlIGUV'
  const BERNARD_VOICE_ID  = 'Q0HZwrR1H2SmRvd5cX3U'
  const LASHONTE_VOICE_ID = 'VYtAZPRhkK9OruILpVBz'
  const KRISTINA_VOICE_ID = 'BlgEcC0TfWpBak7FmvHW'
  const DEVIN_VOICE_ID    = 'YrAYvOVjAFiqVwBgB4qI'
  const MAYA_VOICE_ID     = 'aKw9UnnjRq5scbeeGI7Z'
  const MIKE_VOICE_ID     = 'Ib97zM6uFBc71OWgj75I'
  const ZOE_VOICE_ID      = 'c8v8wiyiDwyuduufV6kB'
  // 4.3.0: DJ Stephen Hands — rare radio guest + DJ Mode default + own picks.
  const DJ_HANDS_VOICE_ID = 'ApBE43wHy5MiZGz9ihqB'

  // Caller scheduler: weighted random with Giovanni anchored ≈1/3, no-
  // repeat-within-3 rule, and a Giovanni-only first 2 caller slots of a
  // fresh session (the show's calling card).
  const CALLER_ROLODEX: { id: 'giovanni' | 'rajiv' | 'bernard' | 'lashonte' | 'kristina' | 'devin' | 'maya' | 'mike' | 'zoe'; weight: number }[] = [
    { id: 'giovanni', weight: 6 },
    { id: 'rajiv',    weight: 2 },
    { id: 'bernard',  weight: 1 },
    { id: 'lashonte', weight: 3 },
    { id: 'kristina', weight: 2 },
    { id: 'devin',    weight: 2 },
    { id: 'maya',     weight: 2 },
    { id: 'mike',     weight: 1 },
    { id: 'zoe',      weight: 2 },
  ]
  const recentCallersRef = useRef<string[]>([])
  const callerSlotsThisSessionRef = useRef(0)

  function pickCaller(): string {
    callerSlotsThisSessionRef.current += 1
    if (callerSlotsThisSessionRef.current <= 2) {
      recentCallersRef.current = ['giovanni', ...recentCallersRef.current].slice(0, 3)
      return 'giovanni'
    }
    const recent = new Set(recentCallersRef.current)
    const eligible = CALLER_ROLODEX.filter(c => !recent.has(c.id))
    const pool = eligible.length > 0 ? eligible : CALLER_ROLODEX
    const total = pool.reduce((sum, c) => sum + c.weight, 0)
    let r = Math.random() * total
    let chosen = pool[0].id
    for (const c of pool) {
      r -= c.weight
      if (r <= 0) { chosen = c.id; break }
    }
    recentCallersRef.current = [chosen, ...recentCallersRef.current].slice(0, 3)
    return chosen
  }

  const RADIO_SPEAKER_LABEL: Record<RadioSpeaker, string> = {
    mm: 'The Music Man',
    megan: 'Megan',
    announcer: 'WJLR',
    djhands: 'Stephen Hands',
    giovanni: 'Giovanni',
    rajiv: 'Rajiv',
    bernard: 'Bernard',
    lashonte: 'LaShonte',
    kristina: 'Kristina',
    devin: 'Devin',
    maya: 'Maya',
    mike: 'Mike',
    zoe: 'Zoe',
  }

  const stripRadioAudioTags = (s: string): string =>
    s.replace(/\s*\[[a-zA-Z][a-zA-Z\s]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim()

  // Deterministic archetype per slot — prefetch and live transition MUST
  // agree or the cache plays the wrong segment shape.
  function archetypeForSlot(slot: number, transitionNum: number): string {
    switch (slot) {
      case 1:  return 'cold-open-hot-take'
      case 2:  return 'back-announce'
      case 3:  return transitionNum % 2 === 0 ? 'lateral-pivot' : 'lineage-bridge'
      case 4:  {
        const opts = ['brooklyn-texture', 'lyric-roast', 'lightning-round'] as const
        return opts[transitionNum % opts.length]
      }
      case 6:  return 'recovery'
      case 8:  return 'historian-dwell'
      case 9:  return 'lightning-round'
      case 10: return 'recovery'
      case 11: return 'hour-out'
      default: return 'back-announce'
    }
  }

  // 4.5 radioV2: lazily create + init the RadioEngine (loads the cast once).
  async function ensureRadioEngine(): Promise<RadioEngine> {
    if (!radioEngineRef.current) {
      radioEngineRef.current = new RadioEngine()
      await radioEngineRef.current.init()
    }
    return radioEngineRef.current
  }

  function computeRadioSlotParams(transitionNum: number, callerId?: string) {
    const slot = transitionNum % 12
    const hourCounter = Math.floor(transitionNum / 12)
    const stephenThisHour = hourCounter % 3 === 0
    const forceAnnouncer = slot === 0
    const miniId = slot === 7
    const callerSegment = slot === 5
    const djHandsSegment = slot === 9 && stephenThisHour
    const useAnnouncer = forceAnnouncer
    let archetypeId: string | undefined
    if (!callerSegment && !djHandsSegment && !miniId && !forceAnnouncer) {
      archetypeId = archetypeForSlot(slot, transitionNum)
    }
    return {
      slot,
      hourCounter,
      useAnnouncer,
      miniId,
      callerSegment,
      djHandsSegment,
      archetypeId,
      callerId: callerSegment ? callerId : undefined,
    }
  }

  function voiceIdForRadioSpeaker(speaker: RadioSpeaker): string | undefined {
    switch (speaker) {
      case 'megan':     return MEGAN_VOICE_ID
      case 'announcer': return ANNOUNCER_VOICE_ID
      case 'djhands':   return DJ_HANDS_VOICE_ID
      case 'giovanni':  return GIOVANNI_VOICE_ID
      case 'rajiv':     return RAJIV_VOICE_ID
      case 'bernard':   return BERNARD_VOICE_ID
      case 'lashonte':  return LASHONTE_VOICE_ID
      case 'kristina':  return KRISTINA_VOICE_ID
      case 'devin':     return DEVIN_VOICE_ID
      case 'maya':      return MAYA_VOICE_ID
      case 'mike':      return MIKE_VOICE_ID
      case 'zoe':       return ZOE_VOICE_ID
      default:          return undefined
    }
  }

  async function synthesizeOneRadioSegment(seg: { speaker: RadioSpeaker; line: string }): Promise<RadioSegment | null> {
    const tts = await window.electronAPI.musicmanSpeak(seg.line, false, voiceIdForRadioSpeaker(seg.speaker))
    if (tts.ok && tts.audio) {
      return { speaker: seg.speaker, line: seg.line, audioData: tts.audio }
    }
    console.warn(`[Radio] TTS dropped a [${seg.speaker.toUpperCase()}] segment:`, tts.error || '(no error reported)', '— line:', seg.line.slice(0, 80))
    return null
  }

  // Parallel TTS with a small concurrency cap — 4× faster than serial
  // without hammering the ElevenLabs rate limiter.
  async function synthesizeRadioSegments(scriptText: string): Promise<RadioSegment[]> {
    const parsed = parseRadioScript(scriptText)
    console.log(`[Radio] parseRadioScript → ${parsed.length} segments:`, parsed.map(p => p.speaker))
    if (parsed.length === 0) return []
    const TTS_CONCURRENCY = 4
    const results: (RadioSegment | null)[] = new Array(parsed.length).fill(null)
    let nextIdx = 0
    async function worker(): Promise<void> {
      while (true) {
        const i = nextIdx++
        if (i >= parsed.length) break
        results[i] = await synthesizeOneRadioSegment(parsed[i])
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(TTS_CONCURRENCY, parsed.length) }, () => worker()),
    )
    const out = results.filter((s): s is RadioSegment => s !== null)
    console.log(`[Radio] synthesizeRadioSegments → ${out.length} usable segments`)
    return out
  }

  // Synthesize then play each segment as soon as its audio is ready —
  // first line drops while later lines are still rendering.
  async function synthesizeAndPlayRadioScript(scriptText: string): Promise<RadioSegment[]> {
    const parsed = parseRadioScript(scriptText)
    if (parsed.length === 0) return []
    const synthPromises = parsed.map(seg => synthesizeOneRadioSegment(seg))
    const played: RadioSegment[] = []
    for (let i = 0; i < parsed.length; i++) {
      const seg = await synthPromises[i]
      if (seg) {
        await playSingleRadioSegment(seg)
        played.push(seg)
      }
    }
    return played
  }

  async function waitForAudioMetadata(audio: HTMLAudioElement): Promise<void> {
    if (!isNaN(audio.duration) && audio.duration > 0) return
    await new Promise<void>((resolve) => {
      const onMeta = () => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }
      audio.addEventListener('loadedmetadata', onMeta)
      setTimeout(() => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }, 1000)
    })
  }

  function playSingleRadioSegment(seg: RadioSegment): Promise<void> {
    return new Promise((resolve) => {
      const caption = stripRadioAudioTags(seg.line)
      // Tape-off-the-radio: the deck (if REC is down) tapes this DJ break.
      window.dispatchEvent(new CustomEvent('jaketunes-radio-segment', { detail: { audioData: seg.audioData } }))
      const audio = new Audio(`data:audio/mpeg;base64,${seg.audioData}`)
      const finish = () => {
        try { detachClipFromBroadcast(audio) } catch { /* ignore */ }
        resolve()
      }
      const syncCaption = async () => {
        await waitForAudioMetadata(audio)
        const durationMs = (audio.duration > 0 && !isNaN(audio.duration)) ? audio.duration * 1000 : 3000
        setBroadcastTimed({ speaker: RADIO_SPEAKER_LABEL[seg.speaker], text: caption }, durationMs)
        setDjText(caption)
      }
      if (seg.speaker === 'announcer') {
        attachAnnouncerToBroadcast(audio)
        djAudioRef.current = audio
        const preType = randomPreStinger()
        const preDur = playStinger(preType)
        audio.onended = () => {
          playStinger(randomEndStinger())
          setTimeout(finish, 200)
        }
        audio.onerror = finish
        void syncCaption()
        setTimeout(() => {
          audio.play().catch(() => finish())
        }, Math.max(50, preDur * 700))
      } else {
        attachClipToBroadcast(audio)
        djAudioRef.current = audio
        audio.onended = finish
        audio.onerror = finish
        void syncCaption().then(() => {
          audio.play().catch(() => finish())
        })
      }
    })
  }

  async function playRadioSegmentSequence(segments: RadioSegment[]): Promise<void> {
    for (const seg of segments) {
      await playSingleRadioSegment(seg)
    }
  }
  // 4.4.0: full caller rolodex tag set.
  function parseRadioScript(text: string): Array<{ speaker: RadioSpeaker; line: string }> {
    const segments: Array<{ speaker: RadioSpeaker; line: string }> = []
    const TAG_RE = /^\[(MM|MEGAN|ANNOUNCER|STEPHEN|DJ_HANDS|DJ_STEPHEN|DJ_STEPHEN_HANDS|GIOVANNI|RAJIV|BERNARD|LASHONTE|KRISTINA|DEVIN|MAYA|MIKE|ZOE)\]\s*(.+)/i
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const m = line.match(TAG_RE)
      if (m) {
        const tag = m[1].toUpperCase()
        let speaker: RadioSpeaker
        switch (tag) {
          case 'MEGAN':     speaker = 'megan'; break
          case 'ANNOUNCER': speaker = 'announcer'; break
          case 'STEPHEN':
          case 'DJ_HANDS':
          case 'DJ_STEPHEN':
          case 'DJ_STEPHEN_HANDS':
            speaker = 'djhands'; break
          case 'GIOVANNI':  speaker = 'giovanni'; break
          case 'RAJIV':     speaker = 'rajiv'; break
          case 'BERNARD':   speaker = 'bernard'; break
          case 'LASHONTE':  speaker = 'lashonte'; break
          case 'KRISTINA':  speaker = 'kristina'; break
          case 'DEVIN':     speaker = 'devin'; break
          case 'MAYA':      speaker = 'maya'; break
          case 'MIKE':      speaker = 'mike'; break
          case 'ZOE':       speaker = 'zoe'; break
          default:          speaker = 'mm'
        }
        segments.push({ speaker, line: m[2].trim() })
      } else if (segments.length > 0) {
        // 4.5: untagged line. The mandatory-[TAG] prompt rule makes these rare,
        // but if the model drops a tag, DON'T lose the dialogue — the old code
        // silently skipped it (a source of vanished lines). Best heuristic: an
        // untagged line is a continuation of the previous speaker, so fold it in.
        console.warn('[Radio] untagged line folded into previous speaker:', line.slice(0, 60))
        segments[segments.length - 1]!.line += ' ' + line
      }
      // (a leading untagged line, before any tagged line, has no speaker to
      //  attach to — dropped, same as before. Rare; would be stray preamble.)
    }
    return segments
  }

  // Pre-fetch radio dialog — starts at track change AND during the last
  // ~120s so Claude + parallel TTS finish before the seam.
  const kickRadioPrefetch = useCallback(async (prevTrack: { id: number; title?: string; artist?: string; album?: string; genre?: string; year?: string | number }, nextTrack: { id: number; title?: string; artist?: string; album?: string; genre?: string; year?: string | number }) => {
    const cacheKey = `${prevTrack.id}-${nextTrack.id}`
    if (RADIO_V2) {
      const upcoming = radioTransitionCounterRef.current + 1
      let params = radioTransitionParamsRef.current.get(cacheKey)
      if (!params) {
        const callerId = computeRadioSlotParams(upcoming).callerSegment ? pickCaller() : undefined
        params = computeRadioSlotParams(upcoming, callerId)
        radioTransitionParamsRef.current.set(cacheKey, params)
      }
      const engine = await ensureRadioEngine()
      void engine.prefetch(buildSegmentReq(prevTrack, nextTrack, params), cacheKey)
      return
    }
    if (radioCacheRef.current.has(cacheKey)) return
    if (radioPrefetchedKeyRef.current === cacheKey) return
    if (radioPrefetchInFlightRef.current === cacheKey) return
    radioPrefetchedKeyRef.current = cacheKey
    radioPrefetchInFlightRef.current = cacheKey
    console.log('[Radio] prefetch starting', { cacheKey })
    try {
      const upcoming = radioTransitionCounterRef.current + 1
      let params = radioTransitionParamsRef.current.get(cacheKey)
      if (!params) {
        const callerId = computeRadioSlotParams(upcoming).callerSegment ? pickCaller() : undefined
        params = computeRadioSlotParams(upcoming, callerId)
        radioTransitionParamsRef.current.set(cacheKey, params)
      }
      const r = await window.electronAPI.musicmanRadio(
        { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
        { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' },
        false,
        params.useAnnouncer,
        params.callerSegment,
        params.djHandsSegment,
        params.callerId,
        params.archetypeId,
        params.slot,
        params.hourCounter,
        params.miniId,
      )
      if (!r.ok || !r.text) {
        console.warn('[Radio] prefetch failed — clearing key for retry', { ok: r.ok, error: r.error })
        if (radioPrefetchedKeyRef.current === cacheKey) radioPrefetchedKeyRef.current = null
        return
      }
      const segments = await synthesizeRadioSegments(r.text)
      if (segments.length === 0) {
        console.warn('[Radio] prefetch synth returned no segments — clearing key')
        if (radioPrefetchedKeyRef.current === cacheKey) radioPrefetchedKeyRef.current = null
        return
      }
      radioCacheRef.current.set(cacheKey, { segments, fullText: r.text })
      console.log('[Radio] prefetch cached', { cacheKey, segments: segments.length })
    } catch (err) {
      console.warn('[Radio] prefetch threw — clearing key for live-fetch fallback', err)
      if (radioPrefetchedKeyRef.current === cacheKey) radioPrefetchedKeyRef.current = null
    } finally {
      if (radioPrefetchInFlightRef.current === cacheKey) radioPrefetchInFlightRef.current = null
    }
  }, [])

  // Kick prefetch as soon as a new track starts in radio mode.
  useEffect(() => {
    if (!radioMode || !pb.nowPlaying) return
    const nextIdx = pb.queueIndex + 1
    if (nextIdx >= pb.queue.length) return
    void kickRadioPrefetch(pb.nowPlaying, pb.queue[nextIdx])
  }, [radioMode, pb.nowPlaying?.id, pb.queueIndex, pb.queue, kickRadioPrefetch])

  useEffect(() => {
    if (!radioMode) return
    if (!pb.nowPlaying || pb.duration <= 0) return
    const remaining = pb.duration - pb.position
    if (remaining > 120) return
    const nextIdx = pb.queueIndex + 1
    if (nextIdx >= pb.queue.length) return
    void kickRadioPrefetch(pb.nowPlaying, pb.queue[nextIdx])
  }, [radioMode, pb.nowPlaying, pb.position, pb.duration, pb.queue, pb.queueIndex, kickRadioPrefetch])

  // Click mic: one-shot DJ comment on current track. Click again to stop.
  const handleDjClick = useCallback(async () => {
    // If actively speaking or autoDj is lingering from a previous mic click, stop everything
    if (djActive || autoDj) {
      djCancelledRef.current = true
      if (djAudioRef.current) {
        // 4.4.14: disconnect from broadcast chain (4.4.6 rattle class).
        detachClipFromBroadcast(djAudioRef.current)
        djAudioRef.current.pause()
        djAudioRef.current = null
        setVolume(savedVolumeRef.current)
      }
      setAutoDj(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      return
    }

    if (!pb.nowPlaying) return
    djCancelledRef.current = false
    let micFailed = ''
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    // 4.4.52: the mic button speaks as the user's CHOSEN host — the
    // Music Man or Megan. buildMusicManPrompt() swaps persona on the
    // aiHost setting, so the bubble must follow. Was hardcoded 'mm',
    // which mis-attributed every comment when Megan was the host.
    const micHost = await window.electronAPI.getActiveHost()
    setDjSpeaker(micHost === 'megan' ? 'megan' : 'mm')
    savedVolumeRef.current = pb.volume

    // 4.5: SINGLE-TTS path (reverted from per-sentence queue). The
    // per-sentence approach produced "5 random voices stitched
    // together" — ElevenLabs gave subtly different inflection per
    // call, and the seams between clips read as different speakers.
    // One TTS on the full response loses the early-start speed but
    // sounds like ONE person delivering the take. Latency is what it
    // is; thinking dots cover it. Caption flips when audio.play()
    // fires so the typewriter (12 cps) starts in step with the voice.
    const stripAudioTags = (s: string): string =>
      s.replace(/\s*\[[a-zA-Z][a-zA-Z\s]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim()

    try {
      const track = pb.nowPlaying
      const persona = micHost === 'megan' ? undefined : undefined
      // Subscribe to chunks but DON'T do anything with them — the
      // stream completion is what matters now. Empty subscribe keeps
      // the IPC channel clean and lets future debug logging slot in
      // without re-wiring.
      const unsubscribe = window.electronAPI.onMusicmanDjChunk(() => { /* no-op */ })
      let result: { ok: boolean; text?: string; error?: string }
      try {
        result = await window.electronAPI.musicmanDjStreaming({
          title: track.title || '', artist: track.artist || '',
          album: track.album || '', genre: track.genre || '', year: track.year || '',
        }, persona)
      } finally {
        unsubscribe()
      }
      if (djCancelledRef.current) return
      console.log('[DJ] Claude response:', result)
      if (result.ok && result.text) {
        const tts = await window.electronAPI.musicmanSpeak(result.text, false)
        if (djCancelledRef.current) return
        console.log('[DJ] TTS response:', tts.ok, tts.error || '')
        if (tts.ok && tts.audio) {
          const caption = stripAudioTags(result.text)
          const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
          attachClipToBroadcast(audio)
          djAudioRef.current = audio
          audio.onended = () => {
            try { detachClipFromBroadcast(audio) } catch { /* ignore */ }
            try { fadeVolumeIn() } catch { /* ignore */ }
            djAudioRef.current = null
            setDjActive(false)
            setAutoDj(false)
            setTimeout(() => {
              setDjExiting(true)
              setTimeout(() => {
                setDjText('')
                setBroadcast(null)
                setDjExiting(false)
              }, 400)
            }, 3000)
          }
          audio.onerror = (err) => {
            console.error('[DJ] Audio playback error:', err)
            try { detachClipFromBroadcast(audio) } catch { /* ignore */ }
            setVolume(savedVolumeRef.current)
            djAudioRef.current = null
            setDjActive(false)
            setAutoDj(false)
            setDjText('')
          }
          await fadeVolumeOut()
          if (djCancelledRef.current) return
          // 4.5: wait for the audio's loadedmetadata so audio.duration
          // is known, then pin the typewriter to that exact length via
          // setBroadcastTimed. Caption finishes exactly when the voice
          // does — no drift on long Music Man takes. djText stays
          // empty so the existing relay useEffect doesn't ALSO fire a
          // regular setBroadcast and double-start the typewriter.
          await new Promise<void>((resolve) => {
            if (!isNaN(audio.duration) && audio.duration > 0) { resolve(); return }
            const onMeta = () => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }
            audio.addEventListener('loadedmetadata', onMeta)
            // 1s belt-and-suspenders: if metadata never lands (rare for
            // a data: URI), proceed with unknown duration — setBroadcast
            // Timed handles durationMs<=0 by revealing instantly.
            setTimeout(() => { audio.removeEventListener('loadedmetadata', onMeta); resolve() }, 1000)
          })
          if (djCancelledRef.current) return
          const durationMs = (audio.duration > 0 && !isNaN(audio.duration)) ? audio.duration * 1000 : 0
          // Order matters: setBroadcastTimed FIRST seeds the activity
          // store with the timed reveal; setDjText afterwards triggers
          // the relay useEffect, which now sees a matching speaking
          // entry and no-ops (see relay guard). Without setDjText
          // here, the relay would treat djText='' + djLoading=false
          // as "clear broadcast" on the next render and wipe the
          // timed reveal.
          setBroadcastTimed({ speaker: BUBBLE_SPEAKER_LABEL[djSpeaker], text: caption }, durationMs)
          setDjLoading(false)
          setDjText(caption)
          await audio.play()
          return
        } else {
          console.warn('[DJ] TTS failed or no audio:', tts.error)
          micFailed = /401|unauthor/i.test(String(tts.error || ''))
            ? "Music Man can't speak — the voice service rejected the key."
            : "Music Man had the words but no voice — speech failed."
        }
      } else {
        console.warn('[DJ] Claude returned no text:', result)
        micFailed = 'Music Man had nothing to say about this one.'
      }
    } catch (err) {
      console.error('[DJ] Error:', err)
      micFailed = "Music Man couldn't reach the mic."
    }
    // 2026-08-25 — Jake: "the mic button lowered the volume but no voice....no
    // fun fact....nothing". Every failure fell through to a console.warn nobody
    // reads, and the volume duck was NEVER undone — the exact
    // reverse-every-side-effect rule in CLAUDE.md. Restore on EVERY path and
    // say what happened; a silently half-volume app is the worst outcome.
    try { fadeVolumeIn() } catch { /* ignore */ }
    if (micFailed) setNotice(micFailed, { kind: 'error', durationMs: 6000 })
    setDjActive(false)
    setDjLoading(false)
    setDjText('')
  }, [djActive, autoDj, pb.nowPlaying, pb.volume, setVolume, fadeVolumeOut, fadeVolumeIn])

  // Auto-DJ / Radio Mode: listen for track transitions. Either flag
  // arms the listener; the body picks which prompt + cache to use.
  useEffect(() => {
    if (!autoDj && !radioMode) return

    const handler = async (e: Event) => {
      // Acknowledge so useAudio knows we're handling this
      window.dispatchEvent(new Event('musicman-dj-transition-ack'))
      const { prevTrack, nextTrack, nextIdx, queue } = (e as CustomEvent).detail

      if (radioTransitionBusyRef.current) {
        console.warn('[Radio] transition already in flight — advancing track')
        playTrack(nextTrack, queue, nextIdx, true)
        return
      }
      radioTransitionBusyRef.current = true

      const cacheKey = `${prevTrack.id}-${nextTrack.id}`

      const advanceAfterBanter = async (segments: RadioSegment[]) => {
        savedVolumeRef.current = pb.volume
        setDjLoading(false)
        await playRadioSegmentSequence(segments)
        djAudioRef.current = null
        setDjActive(false)
        isFadedRef.current = false
        setVolume(savedVolumeRef.current)
        playTrack(nextTrack, queue, nextIdx, true)
        setTimeout(() => {
          setDjExiting(true)
          setTimeout(() => {
            setDjText('')
            setBroadcast(null)
            setDjExiting(false)
          }, 400)
        }, 3000)
      }

      console.log('[Radio] transition fired', {
        radioMode, autoDj,
        prev: prevTrack?.title, next: nextTrack?.title,
        cacheSize: radioCacheRef.current.size,
        prefetchedKey: radioPrefetchedKeyRef.current,
      })
      setDjActive(true)
      setDjLoading(true)
      setDjText('')
      setDjSpeaker('djhands')

      try {
        if (RADIO_V2 && radioMode) {
          radioTransitionCounterRef.current += 1
          const params = radioTransitionParamsRef.current.get(cacheKey)
            ?? computeRadioSlotParams(radioTransitionCounterRef.current, (radioTransitionCounterRef.current % 12) === 5 ? pickCaller() : undefined)
          setDjActive(true); setDjLoading(true); setDjText(''); setDjSpeaker('djhands')
          savedVolumeRef.current = pb.volume
          let played = false
          try {
            const engine = await ensureRadioEngine()
            played = await engine.handleTransition(buildSegmentReq(prevTrack, nextTrack, params), cacheKey)
          } catch (err) { console.error('[radioV2] transition threw', err) }
          if (!played) console.warn('[radioV2] transition produced no audio — advancing silently')
          setDjLoading(false)
          setDjActive(false)
          isFadedRef.current = false
          setVolume(savedVolumeRef.current)
          playTrack(nextTrack, queue, nextIdx, true)
          setTimeout(() => {
            setDjExiting(true)
            setTimeout(() => { setDjText(''); setBroadcast(null); setDjExiting(false) }, 400)
          }, 3000)
          return
        }
        if (radioMode) {
          radioTransitionCounterRef.current += 1
        }

        const params = radioTransitionParamsRef.current.get(cacheKey)
          ?? computeRadioSlotParams(
            radioTransitionCounterRef.current,
            radioMode && (radioTransitionCounterRef.current % 12) === 5 ? pickCaller() : undefined,
          )

        // Radio Mode fast path: pre-fetched dialog cached as a segment array.
        if (radioMode) {
          const cached = radioCacheRef.current.get(cacheKey)
          if (cached && cached.segments.length > 0) {
            radioCacheRef.current.delete(cacheKey)
            radioPrefetchedKeyRef.current = null
            radioTransitionParamsRef.current.delete(cacheKey)
            await advanceAfterBanter(cached.segments)
            return
          }
        }

        try {
          if (radioMode) {
            console.log('[Radio] live fetch starting...', params)
            const r = await window.electronAPI.musicmanRadio(
              { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
              { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' },
              false,
              params.useAnnouncer,
              params.callerSegment,
              params.djHandsSegment,
              params.callerId,
              params.archetypeId,
              params.slot,
              params.hourCounter,
              params.miniId,
            )
            console.log('[Radio] musicmanRadio result', { ok: r.ok, textLen: r.text?.length, error: r.error })
            if (r.ok && r.text) {
              setDjLoading(false)
              savedVolumeRef.current = pb.volume
              const played = await synthesizeAndPlayRadioScript(r.text)
              if (played.length > 0) {
                djAudioRef.current = null
                setDjActive(false)
                isFadedRef.current = false
                setVolume(savedVolumeRef.current)
                playTrack(nextTrack, queue, nextIdx, true)
                setTimeout(() => {
                  setDjExiting(true)
                  setTimeout(() => {
                    setDjText('')
                    setBroadcast(null)
                    setDjExiting(false)
                  }, 400)
                }, 3000)
                return
              }
              console.warn('[Radio] no segments played — TTS may have failed; falling through to silent advance')
            } else {
              console.warn('[Radio] musicmanRadio returned no text', r)
            }
          } else {
            // 4.4.0: DJ Mode (autoDj && !radioMode) is Stephen Hands' lane.
            const result = await window.electronAPI.musicmanDj(
              { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
              { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' },
              'stephen',
            )
            if (result.ok && result.text) {
              const transition = result.transition || 'talk'
              if (transition === 'cut') {
                setDjLoading(false)
                setDjActive(false)
                setDjText('')
                isFadedRef.current = false
                setVolume(savedVolumeRef.current)
                playTrack(nextTrack, queue, nextIdx, true)
                return
              }
              const tts = await window.electronAPI.musicmanSpeak(result.text, false, DJ_HANDS_VOICE_ID)
              setDjLoading(false)
              if (tts.ok && tts.audio) {
                if (transition === 'scratch') {
                  const scratchDur = playStinger('scratch')
                  await new Promise(r => setTimeout(r, scratchDur * 1000))
                }
                await advanceAfterBanter([{ speaker: 'djhands', line: result.text, audioData: tts.audio }])
                return
              }
            }
          }
        } catch (err) {
          console.error('[Radio] transition handler threw', err)
        }
        console.warn('[Radio] falling through to silent track advance')
        setDjActive(false)
        setDjLoading(false)
        setDjText('')
        playTrack(nextTrack, queue, nextIdx, true)
      } finally {
        radioTransitionBusyRef.current = false
        radioTransitionParamsRef.current.delete(cacheKey)
      }
    }

    window.addEventListener('musicman-dj-transition', handler)
    return () => window.removeEventListener('musicman-dj-transition', handler)
  }, [autoDj, radioMode, playTrack, pb.volume, fadeVolumeIn, fadeVolumeOut])

  // ── AirPlay / Audio Output ──
  interface AudioDevice { id: number; name: string; transport: string; isDefault: boolean }
  const [airplayOpen, setAirplayOpen] = useState(false)
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([])
  const [defaultDeviceId, setDefaultDeviceId] = useState<number | null>(null)
  const airplayRef = useRef<HTMLDivElement>(null)

  const refreshDevices = useCallback(async () => {
    try {
      const result = await window.electronAPI.listAudioDevices()
      if (result.ok) {
        setAudioDevices(result.devices)
        const def = result.devices.find(d => d.isDefault)
        setDefaultDeviceId(def ? def.id : null)
      }
    } catch (e) {
      console.warn('[AirPlay] listAudioDevices failed:', e)
    }
  }, [])

  const handleAirplayClick = useCallback(() => {
    if (airplayOpen) {
      setAirplayOpen(false)
    } else {
      refreshDevices()
      setAirplayOpen(true)
    }
  }, [airplayOpen, refreshDevices])

  const handleSelectDevice = useCallback(async (deviceId: number) => {
    const result = await window.electronAPI.setAudioDevice(deviceId)
    if (result.ok) {
      setDefaultDeviceId(deviceId)
    }
    setAirplayOpen(false)
  }, [])

  // Close airplay menu on outside click
  useEffect(() => {
    if (!airplayOpen) return
    const handler = (e: MouseEvent) => {
      if (airplayRef.current && !airplayRef.current.contains(e.target as Node)) {
        setAirplayOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [airplayOpen])

  // Check if a non-builtin device is active (for icon highlight)
  const isExternalOutput = audioDevices.length > 0 && defaultDeviceId != null &&
    audioDevices.find(d => d.id === defaultDeviceId)?.transport !== 'builtin'

  // ── 4.4.15: output-device disconnect UX ──────────────────────────────
  // Three layers of feedback when the active AirPlay/Bluetooth/external
  // device drops mid-playback:
  //
  //   (a) Poll the device list every 5 sec while playing to detect when
  //       the active external device disappears. Notify via the existing
  //       activity-store notice (LCD-pill mode 4 from 4.4.12).
  //   (b) On the next track start, if the previously-active device is
  //       back in the list, auto-switch to it. Cooldown per device id
  //       to avoid reconnect loops on a flaky device.
  //   (c) When the device drops, macOS Core Audio reroutes to internal
  //       speakers automatically — surface that explicitly so the user
  //       always knows where audio is going.
  //
  // Device identity = stable numeric id from the audio helper (NOT name
  // — "Living Room" could be two different AirPlay receivers).
  //
  // Out of scope: Bonjour/mDNS auto-discovery, cross-launch persistence
  // of preferred device.
  const lastExternalDeviceRef = useRef<{ id: number; name: string } | null>(null)
  // Per-device cooldown: deviceId -> last-attempt timestamp (ms). Skip
  // reconnect if attempted within the last 30 sec; reset on age.
  const reconnectAttemptedRef = useRef<Map<number, number>>(new Map())

  // Track which external device the user is currently using. Whenever
  // a non-builtin device becomes default, remember it — that's our
  // reconnect target if it later disappears. Manual switch to builtin
  // clears the ref (user has expressed intent to stay on internal).
  useEffect(() => {
    if (defaultDeviceId == null) return
    const dev = audioDevices.find(d => d.id === defaultDeviceId)
    if (!dev) return
    if (dev.transport === 'builtin') {
      lastExternalDeviceRef.current = null
      return
    }
    lastExternalDeviceRef.current = { id: dev.id, name: dev.name }
  }, [audioDevices, defaultDeviceId])

  // Poll the device list every 5 sec while playing to external. Skip
  // when paused (no point), when on builtin (only external can drop),
  // or when the airplay menu is open (existing refreshDevices covers
  // that window).
  useEffect(() => {
    if (!pb.isPlaying || !isExternalOutput || airplayOpen) return
    const tick = async () => {
      try {
        const result = await window.electronAPI.listAudioDevices()
        if (!result.ok) return
        const last = lastExternalDeviceRef.current
        const stillPresent = last ? result.devices.find(d => d.id === last.id) : null
        // Update local state from the poll regardless of disconnect.
        setAudioDevices(result.devices)
        const def = result.devices.find(d => d.isDefault)
        setDefaultDeviceId(def ? def.id : null)
        // Detect disconnect: the previously-active external device is
        // no longer in the list (Core Audio has rerouted to builtin).
        if (last && !stillPresent) {
          setNotice(`Output → internal speakers (${last.name} unavailable)`, {
            kind: 'info',
            durationMs: 6000,
          })
        }
      } catch (e) {
        console.warn('[AudioDevice] poll failed:', e)
      }
    }
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [pb.isPlaying, isExternalOutput, airplayOpen])

  // On every track start, attempt to reconnect to the previously-active
  // external device if it's back in the list. One attempt per device id
  // per 30-sec window — prevents reconnect-loop on a flaky receiver.
  useEffect(() => {
    if (!pb.nowPlaying?.id) return
    const last = lastExternalDeviceRef.current
    if (!last) return
    // If we're already on this device, nothing to do.
    if (defaultDeviceId === last.id) return
    // Cooldown check.
    const attemptedAt = reconnectAttemptedRef.current.get(last.id)
    if (attemptedAt && Date.now() - attemptedAt < 30_000) return
    ;(async () => {
      try {
        const list = await window.electronAPI.listAudioDevices()
        if (!list.ok) return
        const target = list.devices.find(d => d.id === last.id)
        if (!target) return  // device still gone — nothing to reconnect to
        if (target.isDefault) return  // already on it (race with system reconnect)
        reconnectAttemptedRef.current.set(last.id, Date.now())
        const switchResult = await window.electronAPI.setAudioDevice(last.id)
        if (!switchResult.ok) return
        setNotice(`Reconnected to ${last.name}`, { kind: 'info', durationMs: 4000 })
        // Refresh local state so the AirPlay menu reflects reality next open.
        setAudioDevices(list.devices.map(d => ({ ...d, isDefault: d.id === last.id })))
        setDefaultDeviceId(last.id)
      } catch (e) {
        console.warn('[AudioDevice] auto-reconnect failed:', e)
      }
    })()
  }, [pb.nowPlaying?.id, defaultDeviceId])

  // ── DJ Mode (Spotify-style AI DJ) ──
  const [djModeActive, setDjModeActive] = useState(false)
  const [djModeLoading, setDjModeLoading] = useState(false)
  const [djModeTheme, setDjModeTheme] = useState('')
  const djRecentIds = useRef<number[]>([])
  const djCancelledRef = useRef(false)
  // 4.4.14: generation counter for startDjSet runs. Bumped on every
  // cancel and at the start of every new run; in-flight awaits in
  // startDjSet capture the generation at start and bail when it
  // changes. Fixes the rapid-toggle race where toggling off→on within
  // 500ms while musicmanDjSet/musicmanSpeak was in flight let the
  // STALE response proceed to dispatch state changes (because the
  // re-click reset djCancelledRef to false before the old IPC
  // resolved). See docs/dj-mode-cancel-audit.md.
  const djModeGenerationRef = useRef(0)

  // Broadcast DJ Mode state to sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('dj-mode-state', {
      detail: { active: djModeActive }
    }))
  }, [djModeActive])

  const startDjSet = useCallback(async () => {
    // 4.4.14: each run captures its own generation. Cancel bumps the
    // global counter so a stale in-flight response can detect it's no
    // longer the current run and bail without touching state.
    const myGen = ++djModeGenerationRef.current
    const isStale = () => djModeGenerationRef.current !== myGen
    setDjModeLoading(true)
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    // 4.4.50: the DJ SET INTRO is Stephen Hands too — this was the path
    // 4.4.49 missed (it fixed the mic button + the between-track
    // transition handler, but the set-intro still left djSpeaker as
    // whatever it was, so the intro bubble showed "The Music Man").
    setDjSpeaker('djhands')
    savedVolumeRef.current = pb.volume

    try {
      const compact = lib.tracks.map(t => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, year: t.year,
        bpm: t.bpm ?? null,
        camelotKey: t.camelotKey || '',
        keyRoot: t.keyRoot || '',
        keyMode: t.keyMode || '',
      }))
      const result = await window.electronAPI.musicmanDjSet(compact, djRecentIds.current)

      // Bail out if DJ was cancelled while we were waiting for API,
      // or if a newer startDjSet run has superseded us (rapid toggle).
      if (djCancelledRef.current || isStale()) return

      if (!result.ok || !result.trackIds || result.trackIds.length === 0) {
        console.error('[DJ Mode] Failed to get set:', result.error)
        setDjModeActive(false)
        setDjModeLoading(false)
        setDjActive(false)
        setDjLoading(false)
        return
      }

      // Resolve track IDs to Track objects
      const trackMap = new Map(lib.tracks.map(t => [t.id, t]))
      const setTracks = result.trackIds
        .map(id => trackMap.get(id))
        .filter((t): t is NonNullable<typeof t> => !!t)

      if (setTracks.length === 0) {
        setDjModeActive(false)
        setDjModeLoading(false)
        setDjActive(false)
        setDjLoading(false)
        return
      }

      // Remember these as recently played
      djRecentIds.current = [...djRecentIds.current, ...setTracks.map(t => t.id)].slice(-50)

      setDjModeTheme(result.theme || '')

      // Speak the intro
      if (result.intro) {
        // 4.4.0: DJ Mode is Stephen Hands' lane — route the intro
        // through Stephen's voice instead of Music Man's.
        const tts = await window.electronAPI.musicmanSpeak(result.intro, false, DJ_HANDS_VOICE_ID)

        // Bail out if cancelled during TTS, or superseded by a newer run.
        if (djCancelledRef.current || isStale()) return

        setDjLoading(false)
        if (tts.ok && tts.audio) {
          setDjText(result.intro)
          const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
          attachClipToBroadcast(audio)
          djAudioRef.current = audio
          await fadeVolumeOut()
          await new Promise<void>((resolve) => {
            audio.onended = () => {
              djAudioRef.current = null
              fadeVolumeIn()
              isFadedRef.current = false
              resolve()
            }
            audio.onerror = () => {
              djAudioRef.current = null
              fadeVolumeIn()
              isFadedRef.current = false
              resolve()
            }
            audio.play()
          })
        } else {
          setDjLoading(false)
          setDjText(result.intro)
        }
      } else {
        setDjLoading(false)
      }

      // Bail out if cancelled during intro playback, or superseded.
      if (djCancelledRef.current || isStale()) return

      // Start playing the DJ set with auto-DJ transitions enabled
      setAutoDj(true)
      setDjActive(false)
      setDjModeLoading(false)
      playTrack(setTracks[0], setTracks, 0, true, true)

      // Fade out the intro text after a few seconds
      setTimeout(() => {
        setDjExiting(true)
        setTimeout(() => {
          setDjText('')
          setBroadcast(null)
          setDjExiting(false)
        }, 400)
      }, 4000)

    } catch (err) {
      console.error('[DJ Mode] Error:', err)
      setDjModeActive(false)
      setDjModeLoading(false)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
    }
  }, [lib.tracks, pb.volume, playTrack, setVolume])

  const handleDjModeClick = useCallback(() => {
    if (djModeActive) {
      // Stop DJ mode — kill everything immediately
      djCancelledRef.current = true
      // 4.4.14: invalidate any in-flight startDjSet so a stale IPC
      // response can't proceed (rapid off-then-on within 500ms).
      djModeGenerationRef.current += 1
      setDjModeActive(false)
      setDjModeLoading(false)
      setDjModeTheme('')
      setAutoDj(false)
      setAutoDjMode(false) // immediately clear module-level flag
      if (djAudioRef.current) {
        // 4.4.14: disconnect from broadcast chain (4.4.6 rattle class).
        detachClipFromBroadcast(djAudioRef.current)
        djAudioRef.current.pause()
        djAudioRef.current = null
      }
      setVolume(savedVolumeRef.current)
      setDjActive(false)
      setDjLoading(false)
      setDjText('')
      return
    }

    // Start DJ mode
    djCancelledRef.current = false
    setDjModeActive(true)
    startDjSet()
  }, [djModeActive, startDjSet])

  // Listen for DJ Mode toggle from sidebar button
  useEffect(() => {
    const handler = () => handleDjModeClick()
    window.addEventListener('toggle-dj-mode', handler)
    return () => window.removeEventListener('toggle-dj-mode', handler)
  }, [handleDjModeClick])

  // When the DJ set queue ends and DJ mode is still active, fetch another set
  useEffect(() => {
    if (!djModeActive || !autoDj) return

    const handler = () => {
      // Acknowledge so useAudio knows we're handling this
      window.dispatchEvent(new Event('musicman-dj-set-ended-ack'))
      // The STOP action fires when queue ends — fetch a new set
      if (djModeActive) {
        startDjSet()
      }
    }
    window.addEventListener('musicman-dj-set-ended', handler)
    return () => window.removeEventListener('musicman-dj-set-ended', handler)
  }, [djModeActive, autoDj, startDjSet])

  return (
    <div className="toolbar">
      <TransportControls />
      <div className="now-playing-group">
        <NowPlaying />
        <div className="dj-btn-wrapper">
          <button
            className={`transport-toggle dj-btn ${djActive && !djModeActive ? 'dj-btn--active' : ''} ${djLoading && !djModeActive ? 'dj-btn--loading' : ''}`}
            onClick={handleDjClick}
            onContextMenu={(e) => { e.preventDefault(); setShowBubble(s => !s) }}
            onMouseEnter={() => {
              if (!pb.nowPlaying) return
              if (lastPrefetchedTrackId.current === pb.nowPlaying.id) return
              if (micHoverTimer.current) window.clearTimeout(micHoverTimer.current)
              micHoverTimer.current = window.setTimeout(() => {
                if (!pb.nowPlaying) return
                lastPrefetchedTrackId.current = pb.nowPlaying.id
                window.electronAPI.musicmanPrefetchFacts?.({
                  artist: pb.nowPlaying.artist || '',
                  album: pb.nowPlaying.album || '',
                }).catch(() => { /* fall through to cold-start on click */ })
              }, 200)
            }}
            onMouseLeave={() => {
              if (micHoverTimer.current) {
                window.clearTimeout(micHoverTimer.current)
                micHoverTimer.current = null
              }
            }}
            disabled={!pb.nowPlaying}
            title="Music Man — one-shot comment on the current track (right-click: toggle bubble)"
          >
            <MicIcon />
          </button>
          <button
            className={`transport-toggle dj-btn radio-mode-btn ${radioMode ? 'radio-mode-btn--on' : ''}`}
            onClick={handleRadioToggle}
            title={radioMode ? 'Radio Mode is ON — click to turn OFF (WJLR 330.9, Music Man + Megan)' : 'Radio Mode — click to start WJLR 330.9 (whole library shuffled, MM + Megan banter)'}
          >
            <RadioIcon />
            {radioMode && (
              <>
                <span className="radio-wave radio-wave--1" aria-hidden="true" />
                <span className="radio-wave radio-wave--2" aria-hidden="true" />
                <span className="radio-wave radio-wave--3" aria-hidden="true" />
              </>
            )}
          </button>
          <button
            className={`transport-toggle dj-btn record-btn ${recording ? 'record-btn--on' : ''}`}
            onClick={handleRecordToggle}
            title={recording ? `Recording — click to stop and save as MP3 (${Math.floor(recElapsed/60)}:${String(recElapsed%60).padStart(2,'0')})` : 'Record — capture this broadcast (music + banter) to an MP3 file'}
          >
            <RecordIcon active={recording} />
          </button>
          {/* 4.5: external "ON AIR · WJLR 330.9 · time" pill removed —
              the info now paints inside the now-playing pill via the
              activity store's radio status (setRadio in Toolbar →
              getRadio in NowPlaying). Less visual noise next to the
              transport row, and the WJLR context sits in the same
              eye-line as the song/CC content where it belongs. */}
          {recording && (
            <span className="rec-pill" aria-live="polite">
              <span className="rec-pill-dot" /> REC {Math.floor(recElapsed/60)}:{String(recElapsed%60).padStart(2,'0')}
            </span>
          )}
          {/* 4.5.2: dj-bubble removed — commentary now renders inside the
              now-playing pill as a typewriter caption (NowPlaying's
              'broadcast' mode). See the relay useEffect above that
              wires djText / djLoading -> setBroadcast. */}
        </div>
      </div>
      <div className="volume-group">
      <VolumeSlider />
      <button
        className="transport-toggle viz-btn"
        onClick={() => window.dispatchEvent(new CustomEvent('toggle-visualizer'))}
        title="Visualizer (⌘T) — fullscreen, reacts to what's playing"
        aria-label="Visualizer"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <circle cx="8" cy="8" r="1.7" fill="currentColor" stroke="none" />
          <path d="M8 1.6V3.6M8 12.4V14.4M1.6 8H3.6M12.4 8H14.4M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5l-1.4 1.4M4.9 11.1l-1.4 1.4" />
        </svg>
      </button>
      <div className="airplay-wrapper" ref={airplayRef}>
        <button
          className={`transport-toggle airplay-btn ${isExternalOutput ? 'airplay-btn--active' : ''}`}
          onClick={handleAirplayClick}
          title="Audio Output (AirPlay)"
        >
          <AirPlayIcon active={isExternalOutput} />
        </button>
        {airplayOpen && (
          <div className="airplay-menu">
            <div className="airplay-menu-header">Audio Output</div>
            {audioDevices.map(d => {
              const icon = d.transport === 'airplay' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="7" rx="0.5"/><polygon points="6,7 3,11 9,11" fill="currentColor"/></svg>
              ) : d.transport === 'bluetooth' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 3l6 3-6 3M6 0v12M9 3L6 0v5"/><path d="M9 9L6 12V7"/></svg>
              ) : d.transport === 'builtin' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 3a1 1 0 011-1h8a1 1 0 011 1v5a1 1 0 01-1 1H7l-1 2-1-2H2a1 1 0 01-1-1V3z"/></svg>
              ) : d.transport === 'usb' || d.transport === 'hdmi' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M1 5v2h2l3 3V2L3 5H1z"/><path d="M8.5 3.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M1 5v2h2l3 3V2L3 5H1z"/></svg>
              )
              return (
                <div
                  key={d.id}
                  className={`airplay-menu-item ${d.id === defaultDeviceId ? 'airplay-menu-item--active' : ''}`}
                  onClick={() => handleSelectDevice(d.id)}
                >
                  <span className="airplay-check">{d.id === defaultDeviceId ? '\u2713' : ''}</span>
                  <span className="airplay-device-icon">{icon}</span>
                  {d.name}
                </div>
              )
            })}
            {!audioDevices.some(d => d.transport === 'airplay') && (
              <div
                className="airplay-menu-hint"
                style={{ padding: '6px 12px 4px', fontSize: 11, color: '#9a9a9a', lineHeight: 1.4 }}
              >
                No AirPlay devices found. Pick one in macOS Control Center → Sound (or Sound Settings below), then reopen this menu — macOS only exposes a receiver once it's connected.
              </div>
            )}
            <div className="airplay-menu-divider" />
            <div
              className="airplay-menu-item airplay-menu-item--settings"
              onClick={() => {
                setAirplayOpen(false)
                window.electronAPI.openSoundSettings()
              }}
            >
              <span className="airplay-check" />
              <span className="airplay-device-icon">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="2"/><path d="M6 1v1M6 10v1M1 6h1M10 6h1M2.5 2.5l.7.7M8.8 8.8l.7.7M9.5 2.5l-.7.7M3.2 8.8l-.7.7"/></svg>
              </span>
              Sound Settings...
            </div>
          </div>
        )}
      </div>
      </div>
      <button
        className={`transport-toggle queue-toggle ${showQueue ? 'queue-toggle--active' : ''}`}
        onClick={onToggleQueue}
        title="Up Next"
        onDragOver={(e) => {
          e.preventDefault()
          if (!showQueue) onOpenQueue()
        }}
      >
        <QueueIcon />
      </button>
      <SearchPill />
    </div>
  )
}
