import { useState, useCallback, useRef, useEffect } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio, setAutoDjMode } from '../../hooks/useAudio'
import { attachClipToBroadcast, attachAnnouncerToBroadcast, startRecording, stopRecording } from '../../audio/eq'
import { playStinger, randomPreStinger, randomEndStinger, STINGER_DURATIONS } from '../../audio/stingers'
import TransportControls from './TransportControls'
import NowPlaying from './NowPlaying'
import VolumeSlider from './VolumeSlider'
import SearchPill from './SearchPill'

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
  type RadioSegment = { speaker: 'mm' | 'megan' | 'announcer' | 'giovanni' | 'djhands'; line: string; audioData: string }
  const radioCacheRef = useRef<Map<string, { segments: RadioSegment[]; fullText: string }>>(new Map())
  // 4.2.7: deterministic announcer scheduling. The opener always has
  // an [ANNOUNCER] drop; between-track transitions get one every 4th
  // transition (predictable cadence — roughly one drop every 4 songs
  // after the opener). Counter is reset when Radio Mode toggles off.
  const radioTransitionCounterRef = useRef<number>(0)
  const radioPrefetchedKeyRef = useRef<string | null>(null)
  const [djActive, setDjActive] = useState(false)
  const [djText, setDjText] = useState('')
  const [djLoading, setDjLoading] = useState(false)
  const [showBubble, setShowBubble] = useState(true)
  const [djExiting, setDjExiting] = useState(false)
  const savedVolumeRef = useRef(0.8)
  const djAudioRef = useRef<HTMLAudioElement | null>(null)

  const fadeVolumeIn = useCallback(() => {
    const target = savedVolumeRef.current
    const start = target * 0.15
    let step = 0
    const fade = setInterval(() => {
      step++
      if (step >= 30) {
        setVolume(target)
        clearInterval(fade)
      } else {
        setVolume(start + (target - start) * (step / 30))
      }
    }, 50)
  }, [setVolume])

  const fadeVolumeOut = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const start = savedVolumeRef.current
      const target = start * 0.15
      let step = 0
      const fade = setInterval(() => {
        step++
        if (step >= 20) {
          setVolume(target)
          clearInterval(fade)
          resolve()
        } else {
          setVolume(start - (start - target) * (step / 20))
        }
      }, 50)
    })
  }, [setVolume])

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

  // Cancel DJ when user manually plays a track
  useEffect(() => {
    const handler = () => {
      djCancelledRef.current = true
      setAutoDjMode(false) // immediately clear module-level flag
      if (djAudioRef.current) {
        djAudioRef.current.pause()
        djAudioRef.current = null
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
  }, [setVolume])

  // Sync auto-DJ mode to audio module. Either DJ-Set's autoDj OR the
  // user-toggled Radio Mode triggers the between-track event the
  // transition handler listens on.
  useEffect(() => {
    setAutoDjMode(autoDj || radioMode)
  }, [autoDj, radioMode])

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
      setRadioMode(false)
      radioCacheRef.current.clear()
      radioPrefetchedKeyRef.current = null
      radioTransitionCounterRef.current = 0
      return
    }
    setAutoDj(false)
    const tracks = lib.tracks
    if (tracks.length === 0) return
    const shuffled = [...tracks].sort(() => Math.random() - 0.5)
    const firstTrack = shuffled[0]
    setRadioMode(true)
    stopPlayback()
    console.log('[Radio] toggle ON — generating opener…')

    // Hard timeout for the whole opener flow (IPC + TTS + segment
    // playback). If anything in the chain hangs (Claude latency,
    // ElevenLabs, network blip, decoder stall), we fall through to
    // playTrack within 15s so the user is NEVER left staring at a
    // dead radio button.
    const TIMEOUT_MS = 15000
    const openerDone = new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => { if (!resolved) { resolved = true; resolve() } }
      setTimeout(() => {
        if (!resolved) console.warn(`[Radio] opener timeout after ${TIMEOUT_MS}ms — starting track`)
        finish()
      }, TIMEOUT_MS)

      ;(async () => {
        try {
          console.log('[Radio] calling musicmanRadio (opener)…')
          const r = await window.electronAPI.musicmanRadio(
            { title: '', artist: '', album: '', genre: '', year: '' },
            { title: firstTrack.title || '', artist: firstTrack.artist || '', album: firstTrack.album || '', genre: firstTrack.genre || '', year: firstTrack.year || '' },
            true,
            true,
          )
          console.log('[Radio] musicmanRadio returned ok=' + r.ok + ' text-length=' + (r.text?.length ?? 0))
          if (!r.ok || !r.text) { finish(); return }
          if (resolved) return  // timeout already fired
          console.log('[Radio] OPENER FULL TEXT:\n' + r.text)
          console.log('[Radio] synthesizing segments…')
          const segments = await synthesizeRadioSegments(r.text)
          console.log('[Radio] got ' + segments.length + ' segments, speakers:', segments.map(s => s.speaker))
          if (resolved) return
          if (segments.length === 0) { finish(); return }
          let i = 0
          const playOne = (): void => {
            if (resolved) return
            if (i >= segments.length) { finish(); return }
            const seg = segments[i++]
            const audio = new Audio(`data:audio/mpeg;base64,${seg.audioData}`)
            if (seg.speaker === 'announcer') {
              // 4.3.3: opener announcer drops also get full broadcast
              // FX + stinger treatment.
              attachAnnouncerToBroadcast(audio)
              djAudioRef.current = audio
              const preType = randomPreStinger()
              const preDur = playStinger(preType)
              audio.onended = () => {
                playStinger(randomEndStinger())
                setTimeout(playOne, 200)
              }
              audio.onerror = () => { console.warn('[Radio] opener announcer errored, advancing'); playOne() }
              setTimeout(() => {
                audio.play().catch((e) => { console.warn('[Radio] opener announcer play() rejected:', e); playOne() })
              }, Math.max(50, preDur * 700))
            } else {
              attachClipToBroadcast(audio)
              djAudioRef.current = audio
              audio.onended = playOne
              audio.onerror = () => { console.warn('[Radio] segment ' + (i-1) + ' errored, advancing'); playOne() }
              audio.play().catch((e) => { console.warn('[Radio] segment play() rejected:', e); playOne() })
            }
          }
          playOne()
        } catch (err) {
          console.warn('[Radio] opener flow threw, starting track directly:', err)
          finish()
        }
      })()
    })
    await openerDone
    djAudioRef.current = null
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
    playTrack(firstTrack, shuffled, 0, true)
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
      playTrack(shuffled[0], shuffled, 0, false)
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
  // 4.2.19: Giovanni — caller character. He phones into the show and
  // asks music questions ranging from sharp to confused. MM and Megan
  // react in character. Voice is conversational / regular-guy on a
  // phone, NOT broadcast-polished.
  const GIOVANNI_VOICE_ID = 'UOB3uZCEf2cjGpZaGOXq'
  // 4.3.0: DJ Stephen Hands — rare radio guest + DJ Mode default + own picks.
  // Tag is [STEPHEN] (or legacy [DJ_HANDS] still accepted in case Claude
  // emits the older form during transition).
  const DJ_HANDS_VOICE_ID = 'ApBE43wHy5MiZGz9ihqB'

  // Parse a Claude-generated radio script into ordered speaker segments.
  // Strict format: each line begins with [MM], [MEGAN], [ANNOUNCER],
  // [GIOVANNI], or [STEPHEN]. Anything else is silently dropped.
  function parseRadioScript(text: string): Array<{ speaker: 'mm' | 'megan' | 'announcer' | 'giovanni' | 'djhands'; line: string }> {
    type Speaker = 'mm' | 'megan' | 'announcer' | 'giovanni' | 'djhands'
    const segments: Array<{ speaker: Speaker; line: string }> = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const m = line.match(/^\[(MM|MEGAN|ANNOUNCER|GIOVANNI|STEPHEN|DJ_HANDS|DJ_STEPHEN|DJ_STEPHEN_HANDS)\]\s*(.+)/i)
      if (m) {
        const tag = m[1].toUpperCase()
        const speaker: Speaker =
          tag === 'MEGAN' ? 'megan' :
          tag === 'ANNOUNCER' ? 'announcer' :
          tag === 'GIOVANNI' ? 'giovanni' :
          tag === 'STEPHEN' || tag === 'DJ_HANDS' || tag === 'DJ_STEPHEN' || tag === 'DJ_STEPHEN_HANDS' ? 'djhands' :
          'mm'
        segments.push({ speaker, line: m[2].trim() })
      }
    }
    return segments
  }

  // Synthesize each script line with the appropriate voice. Sequential
  // (not parallel) to be polite to the ElevenLabs rate limiter and so
  // the array stays ordered.
  async function synthesizeRadioSegments(scriptText: string): Promise<RadioSegment[]> {
    const parsed = parseRadioScript(scriptText)
    console.log(`[Radio] parseRadioScript → ${parsed.length} segments:`, parsed.map(p => p.speaker))
    const out: RadioSegment[] = []
    for (const seg of parsed) {
      const voiceId =
        seg.speaker === 'megan' ? MEGAN_VOICE_ID :
        seg.speaker === 'announcer' ? ANNOUNCER_VOICE_ID :
        seg.speaker === 'giovanni' ? GIOVANNI_VOICE_ID :
        seg.speaker === 'djhands' ? DJ_HANDS_VOICE_ID :
        undefined  // mm → server-side default
      const tts = await window.electronAPI.musicmanSpeak(seg.line, false, voiceId)
      if (tts.ok && tts.audio) {
        out.push({ speaker: seg.speaker, line: seg.line, audioData: tts.audio })
      } else {
        // 4.3.4: surface the dropped segment so we can debug. Previously
        // a TTS failure (e.g. v3 not supporting a specific voice) silently
        // dropped the segment from the array, so the user heard the rest
        // of the script with the dropped speaker missing — manifested as
        // "no station ID played" when announcer's TTS failed.
        console.warn(`[Radio] TTS dropped a [${seg.speaker.toUpperCase()}] segment:`, tts.error || '(no error reported)', '— line:', seg.line.slice(0, 80))
      }
    }
    console.log(`[Radio] synthesizeRadioSegments → ${out.length} usable segments`)
    return out
  }

  // Pre-fetch radio dialog during the last ~30s of the current track.
  // Result lands in the cache as an array of {speaker, line, audioData}
  // segments ready for sequential playback.
  useEffect(() => {
    if (!radioMode) return
    if (!pb.nowPlaying || pb.duration <= 0) return
    const remaining = pb.duration - pb.position
    // 4.3.2: prefetch window pushed earlier (60s remaining instead of
    // 30s) so Claude generation + per-segment ElevenLabs synthesis has
    // headroom to complete before the song ends. Multi-segment radio
    // dialog can take 15-25 seconds to fully synthesize; 30s of lead
    // time was cutting it close and meant live-fetch fallback fired
    // often, which is the slow path.
    if (remaining > 60 || remaining < 5) return
    const nextIdx = pb.queueIndex + 1
    if (nextIdx >= pb.queue.length) return
    const nextTrack = pb.queue[nextIdx]
    const cacheKey = `${pb.nowPlaying.id}-${nextTrack.id}`
    if (radioPrefetchedKeyRef.current === cacheKey) return
    if (radioCacheRef.current.has(cacheKey)) return
    radioPrefetchedKeyRef.current = cacheKey
    console.log('[Radio] prefetch starting', { cacheKey, remaining: remaining.toFixed(1) })
    ;(async () => {
      try {
        const prev = pb.nowPlaying!
        // Look ahead at what the counter WILL be when this transition
        // fires (current + 1). Mirror the rotation logic from the
        // transition handler so the prefetch matches what's actually
        // requested live (otherwise the live-fetch path runs anyway).
        const upcoming = radioTransitionCounterRef.current + 1
        const upcomingSlot = upcoming % 12
        const upcomingForceAnn = upcomingSlot === 0 || upcomingSlot === 4 || upcoming % 4 === 0
        const upcomingCaller   = upcomingSlot === 5 || upcomingSlot === 11
        const upcomingDjHands  = upcomingSlot === 9
        const upcomingUseAnn   = upcomingForceAnn && !upcomingCaller && !upcomingDjHands
        const r = await window.electronAPI.musicmanRadio(
          { title: prev.title || '', artist: prev.artist || '', album: prev.album || '', genre: prev.genre || '', year: prev.year || '' },
          { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' },
          false,
          upcomingUseAnn,
          upcomingCaller,
          upcomingDjHands,
        )
        if (!r.ok || !r.text) {
          console.warn('[Radio] prefetch failed — clearing key for retry', { ok: r.ok, error: r.error })
          // 4.2.15: clear the key so the transition handler can live-fetch
          // without thinking a prefetch is "in flight or already done."
          if (radioPrefetchedKeyRef.current === cacheKey) {
            radioPrefetchedKeyRef.current = null
          }
          return
        }
        const segments = await synthesizeRadioSegments(r.text)
        if (segments.length === 0) {
          console.warn('[Radio] prefetch synth returned no segments — clearing key')
          if (radioPrefetchedKeyRef.current === cacheKey) {
            radioPrefetchedKeyRef.current = null
          }
          return
        }
        radioCacheRef.current.set(cacheKey, { segments, fullText: r.text })
        console.log('[Radio] prefetch cached', { cacheKey, segments: segments.length })
      } catch (err) {
        console.warn('[Radio] prefetch threw — clearing key for live-fetch fallback', err)
        if (radioPrefetchedKeyRef.current === cacheKey) {
          radioPrefetchedKeyRef.current = null
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radioMode, pb.nowPlaying, pb.position, pb.duration, pb.queue, pb.queueIndex])

  // Click mic: one-shot DJ comment on current track. Click again to stop.
  const handleDjClick = useCallback(async () => {
    // If actively speaking or autoDj is lingering from a previous mic click, stop everything
    if (djActive || autoDj) {
      djCancelledRef.current = true
      if (djAudioRef.current) {
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
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    savedVolumeRef.current = pb.volume

    try {
      const track = pb.nowPlaying
      const result = await window.electronAPI.musicmanDj({
        title: track.title || '', artist: track.artist || '',
        album: track.album || '', genre: track.genre || '', year: track.year || '',
      })
      if (djCancelledRef.current) return
      console.log('[DJ] Claude response:', result)
      if (result.ok && result.text) {
        const tts = await window.electronAPI.musicmanSpeak(result.text, false)
        if (djCancelledRef.current) return
        console.log('[DJ] TTS response:', tts.ok, tts.error || '')
        setDjLoading(false)
        if (tts.ok && tts.audio) {
          setDjText(result.text)
          const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
          attachClipToBroadcast(audio)
          djAudioRef.current = audio
          audio.onended = () => {
            fadeVolumeIn()
            djAudioRef.current = null
            setDjActive(false)
            setAutoDj(false)
            setTimeout(() => {
              setDjExiting(true)
              setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
            }, 3000)
          }
          audio.onerror = (err) => {
            console.error('[DJ] Audio playback error:', err)
            setVolume(savedVolumeRef.current)
            djAudioRef.current = null
            setDjActive(false)
            setAutoDj(false)
            setDjText('')
          }
          await fadeVolumeOut()
          await audio.play()
          return
        } else {
          console.warn('[DJ] TTS failed or no audio:', tts.error)
        }
      } else {
        console.warn('[DJ] Claude returned no text:', result)
      }
    } catch (err) {
      console.error('[DJ] Error:', err)
    }
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
      console.log('[Radio] transition fired', {
        radioMode, autoDj,
        prev: prevTrack?.title, next: nextTrack?.title,
        cacheSize: radioCacheRef.current.size,
        prefetchedKey: radioPrefetchedKeyRef.current,
      })
      setDjActive(true)
      setDjLoading(true)
      setDjText('')

      // Helper: play an array of {speaker, line, audioData} segments
      // over the next track at ducked volume — real-radio-DJ style.
      //
      // 4.3.2: REAL-RADIO TIMING. Dialog plays at the SEAM (in silence),
      // next track starts AFTER the last segment. Previous (4.2.16)
      // approach started the next track at ducked volume immediately
      // and let dialog play over it — but TTS+API latency could leave
      // the next song playing 30-45 seconds before banter actually
      // dropped, which is the opposite of how real radio works. Real
      // FM: previous song fades out → DJs talk in silence (or near-
      // silence) → next song fades in. We do that now.
      const playSegmentSequence = async (segments: RadioSegment[], displayText: string) => {
        setDjText(displayText)
        savedVolumeRef.current = pb.volume

        // 1. Play segments in silence — no music underneath. The
        //    previous song already ended naturally; we just don't
        //    start the next one yet. ANNOUNCER segments get the
        //    full broadcast-FX treatment + stingers (4.3.3).
        let i = 0
        await new Promise<void>((resolve) => {
          const playOne = (): void => {
            if (i >= segments.length) { resolve(); return }
            const seg = segments[i++]
            const audio = new Audio(`data:audio/mpeg;base64,${seg.audioData}`)
            if (seg.speaker === 'announcer') {
              // Production-rated path: pre-stinger riser → broadcast-
              // processed announcer voice → endcap stinger.
              attachAnnouncerToBroadcast(audio)
              djAudioRef.current = audio
              const preType = randomPreStinger()
              const preDur = playStinger(preType)
              audio.onended = () => {
                playStinger(randomEndStinger())
                // Brief beat after the endcap, then continue.
                setTimeout(playOne, 200)
              }
              audio.onerror = playOne
              // Wait until ~70% through the riser before announcer
              // voice kicks in — the riser builds INTO the drop.
              setTimeout(() => {
                audio.play().catch(() => playOne())
              }, Math.max(50, preDur * 700))
            } else {
              // Normal MM / Megan / Giovanni / DJ Hands path — direct
              // through preamp/EQ.
              attachClipToBroadcast(audio)
              djAudioRef.current = audio
              audio.onended = playOne
              audio.onerror = playOne
              audio.play().catch(() => playOne())
            }
          }
          playOne()
        })

        // 2. Segments done. Start the next track at the user's actual
        //    volume — no ducking needed since dialog already finished.
        djAudioRef.current = null
        setDjActive(false)
        isFadedRef.current = false
        setVolume(savedVolumeRef.current)
        playTrack(nextTrack, queue, nextIdx, true)

        // 3. Bubble fade-out shortly after the new song starts.
        setTimeout(() => {
          setDjExiting(true)
          setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
        }, 3000)
      }

      // Bump the transition counter ONCE per real transition. Used by
      // both the cache-hit and live-fetch paths to decide announcer
      // scheduling. (The pre-fetch effect peeks at counter+1 to align
      // its forceAnnouncer decision with what THIS transition will
      // actually compute.)
      if (radioMode) {
        radioTransitionCounterRef.current += 1
      }
      // 4.2.19: rotation slot mapping (per-transition counter modulo 12,
      // so the show feels like a real rotation rather than the same
      // four-beat loop):
      //   slot 0  → forceAnnouncer (campy station ID)
      //   slot 4  → forceAnnouncer (second station ID in the dozen)
      //   slot 5  → callerSegment (Giovanni phones in)
      //   slot 9  → djHandsSegment (rare DJ Hands guest spot)
      //   slot 11 → callerSegment (Giovanni again — he loves this show)
      //   else    → pure MM + Megan banter
      // Counter starts at 1 after the first increment, so transition 1 ≠
      // slot 0 (slot 0 would only fire on a 12-counter wrap to 0). The
      // "every 4th" announcer cadence is preserved because we're using
      // counter % 4 below as a fallback for non-special slots.
      const slot = radioTransitionCounterRef.current % 12
      const forceAnnouncerThisTransition = radioMode && (slot === 0 || slot === 4 || radioTransitionCounterRef.current % 4 === 0)
      const callerThisTransition         = radioMode && (slot === 5 || slot === 11)
      const djHandsThisTransition        = radioMode && (slot === 9)
      // Mutual-exclude: callers/DJ Hands suppress the announcer drop in
      // their own segment so the structure doesn't get crowded.
      const useAnnouncer = forceAnnouncerThisTransition && !callerThisTransition && !djHandsThisTransition

      // Radio Mode fast path: pre-fetched dialog cached as a segment array.
      if (radioMode) {
        const cacheKey = `${prevTrack.id}-${nextTrack.id}`
        const cached = radioCacheRef.current.get(cacheKey)
        if (cached && cached.segments.length > 0) {
          radioCacheRef.current.delete(cacheKey)
          radioPrefetchedKeyRef.current = null
          setDjLoading(false)
          await playSegmentSequence(cached.segments, cached.fullText)
          return
        }
      }

      // Live fetch path. Radio Mode → musicmanRadio + per-segment TTS;
      // DJ Set autoDj → musicmanDj + single-clip TTS.
      // 4.2.15: every failure mode is now logged. The empty catch was
      // swallowing API errors, prefetch failures, and TTS issues — leaving
      // the user with "they speak once and never come back" and no clue why.
      try {
        if (radioMode) {
          console.log('[Radio] live fetch starting...', { slot, useAnnouncer, callerThisTransition, djHandsThisTransition })
          const r = await window.electronAPI.musicmanRadio(
            { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
            { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' },
            false,
            useAnnouncer,
            callerThisTransition,
            djHandsThisTransition,
          )
          console.log('[Radio] musicmanRadio result', { ok: r.ok, textLen: r.text?.length, error: r.error })
          if (r.ok && r.text) {
            const segments = await synthesizeRadioSegments(r.text)
            console.log('[Radio] synthesized segments', { count: segments.length, speakers: segments.map(s => s.speaker) })
            setDjLoading(false)
            if (segments.length > 0) {
              await playSegmentSequence(segments, r.text)
              return
            }
            console.warn('[Radio] no segments synthesized — TTS may have failed; falling through to silent advance')
          } else {
            console.warn('[Radio] musicmanRadio returned no text', r)
          }
        } else {
          const result = await window.electronAPI.musicmanDj(
            { title: prevTrack.title || '', artist: prevTrack.artist || '', album: prevTrack.album || '', genre: prevTrack.genre || '', year: prevTrack.year || '' },
            { title: nextTrack.title || '', artist: nextTrack.artist || '', album: nextTrack.album || '', genre: nextTrack.genre || '', year: nextTrack.year || '' }
          )
          if (result.ok && result.text) {
            const tts = await window.electronAPI.musicmanSpeak(result.text, false)
            setDjLoading(false)
            if (tts.ok && tts.audio) {
              await playSegmentSequence([{ speaker: 'mm', line: result.text, audioData: tts.audio }], result.text)
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

  // ── DJ Mode (Spotify-style AI DJ) ──
  const [djModeActive, setDjModeActive] = useState(false)
  const [djModeLoading, setDjModeLoading] = useState(false)
  const [djModeTheme, setDjModeTheme] = useState('')
  const djRecentIds = useRef<number[]>([])
  const djCancelledRef = useRef(false)

  // Broadcast DJ Mode state to sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('dj-mode-state', {
      detail: { active: djModeActive }
    }))
  }, [djModeActive])

  const startDjSet = useCallback(async () => {
    setDjModeLoading(true)
    setDjActive(true)
    setDjLoading(true)
    setDjText('')
    savedVolumeRef.current = pb.volume

    try {
      const compact = lib.tracks.map(t => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, year: t.year,
      }))
      const result = await window.electronAPI.musicmanDjSet(compact, djRecentIds.current)

      // Bail out if DJ was cancelled while we were waiting for API
      if (djCancelledRef.current) return

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
        const tts = await window.electronAPI.musicmanSpeak(result.intro, false)

        // Bail out if cancelled during TTS
        if (djCancelledRef.current) return

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

      // Bail out if cancelled during intro playback
      if (djCancelledRef.current) return

      // Start playing the DJ set with auto-DJ transitions enabled
      setAutoDj(true)
      setDjActive(false)
      setDjModeLoading(false)
      playTrack(setTracks[0], setTracks, 0, true)

      // Fade out the intro text after a few seconds
      setTimeout(() => {
        setDjExiting(true)
        setTimeout(() => { setDjText(''); setDjExiting(false) }, 400)
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
      setDjModeActive(false)
      setDjModeLoading(false)
      setDjModeTheme('')
      setAutoDj(false)
      setAutoDjMode(false) // immediately clear module-level flag
      if (djAudioRef.current) {
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
          {radioMode && (
            <span className="radio-on-air-pill" aria-live="polite">ON AIR · WJLR 330.9</span>
          )}
          {recording && (
            <span className="rec-pill" aria-live="polite">
              <span className="rec-pill-dot" /> REC {Math.floor(recElapsed/60)}:{String(recElapsed%60).padStart(2,'0')}
            </span>
          )}
          {showBubble && !radioMode && (djLoading || djText) && (
            <div className={`dj-bubble ${djExiting ? 'dj-bubble--exiting' : ''}`}>
              {djLoading ? (
                <>
                  <span className="dj-bubble-label">The Music Man</span>{' '}
                  <span className="dj-loading-dots">is listening</span>
                </>
              ) : (
                <>
                  <span className="dj-bubble-label">The Music Man:</span> {djText}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="volume-group">
      <VolumeSlider />
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
