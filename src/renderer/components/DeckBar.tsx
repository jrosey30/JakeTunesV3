/**
 * DeckBar — the tape recorder engine + the traveling strip.
 *
 * Jake's rules, verbatim where possible:
 * - "play means play" — PLAY/PAUSE is the toolbar's own togglePlayPause.
 * - REC down = whatever plays lands on the tape. Popping REC out does
 *   NOT stop the music. Pressing REC back down mid-song records the
 *   song FROM RIGHT THERE (startOffsets — the tape only has its tail).
 * - MIC is a switch: on = mic ready. It only records onto the tape
 *   while REC is ALSO down — mic + record is when your voice goes on.
 * - True physics always: sides fill, boundary songs cut, auto-flip
 *   A→B, tape full pops REC out. Every landing persists. No undo.
 *
 * The engine (landing + mic capture) lives HERE and always runs while a
 * tape is in the deck. The visual strip hides on that tape's own page —
 * the faceplate there drives the same deck state.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import {
  getDeckState, setDeckState, getMixtapes, getTapeSession, getMixtapeId,
  subscribeMixtapes, refreshMixtapes, liveTapeCounter,
} from '../mixtapes'
import { effectiveDurationFn, tapeTracks, MAX_TAPE_SONGS } from '../../common/tape-physics'
import { mechanicalSound, tapeMotorPause } from '../tapeDeck'
import type { Mixtape } from '../types'
import '../styles/mixtape.css'

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function DeckBar() {
  const { state: lib } = useLibrary()
  const { state: pb } = usePlayback()
  const { togglePlayPause } = useAudio()
  const deck = useSyncExternalStore(subscribeMixtapes, getDeckState)
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  const activeMixtapeId = useSyncExternalStore(subscribeMixtapes, getMixtapeId)
  const [notice, setNotice] = useState('')
  const [micCapturing, setMicCapturing] = useState(false)
  const lastLandedRef = useRef<number | null>(null)
  const micRecRef = useRef<MediaRecorder | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micChunksRef = useRef<Blob[]>([])
  const micPinRef = useRef<{ atMs: number } | null>(null)

  const tape: Mixtape | undefined = deck ? mixtapes.find((m) => m.id === deck.mixtapeId) : undefined
  const durOf = useCallback((id: number) => lib.tracks.find((t) => t.id === id)?.duration || undefined, [lib.tracks])

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), 3500)
  }

  const persist = useCallback(async (next: Mixtape) => {
    await window.electronAPI.saveMixtape?.(next)
    await refreshMixtapes()
  }, [])

  const nowId = pb.nowPlaying?.id

  // ── landing: one path for both "song started while REC down" (offset
  // 0) and "REC pressed mid-song" (offset = playhead). ──
  const landTrack = useCallback((id: number, startMs: number) => {
    const d = getDeckState()
    const t = d ? getMixtapes().find((m) => m.id === d.mixtapeId) : undefined
    if (!d || !t) return
    // THE TAPE IS LINEAR (Jake: "preestablishing songs on side A and B is
    // dumb... side A of the tape is still recording!!") — and as of
    // 2026-08-08 it is also ONE sequence with a 25-song limit. So a song
    // either isn't on the tape yet and gets appended, or it already is and
    // this is a no-op. The old A//B juggling — pulling a song out of Side
    // B's plan while A rolled, fitting against a minutes budget, cutting
    // the boundary song, auto-flipping — all belonged to the two-sided
    // cassette and is gone with it.
    const current = tapeTracks(t)
    if (current.includes(id)) return          // already on tape
    if (current.length >= MAX_TAPE_SONGS) {
      setDeckState({ ...d, recArmed: false })
      flash(`Tape full — ${MAX_TAPE_SONGS} songs. REC popped out.`)
      return
    }
    const offsets = { ...(t.startOffsets || {}) }
    if (startMs > 1500) offsets[String(id)] = Math.round(startMs)
    const next: Mixtape = { ...t, tracks: [...current, id], startOffsets: offsets }
    lastLandedRef.current = id
    const left = MAX_TAPE_SONGS - next.tracks!.length
    if (left === 0) {
      setDeckState({ ...d, recArmed: false })
      const title = lib.tracks.find((x) => x.id === id)?.title || 'song'
      flash(`“${title}” fills the tape — that's all ${MAX_TAPE_SONGS}.`)
    }
    void persist(next)
  }, [lib.tracks, persist])

  // song starts while REC is down → lands whole (offset 0)
  useEffect(() => {
    if (!deck?.recArmed || !tape || nowId == null || !pb.isPlaying) return
    if (getTapeSession()) return // playing the tape itself — can't dub itself
    if (lastLandedRef.current === nowId) return
    landTrack(nowId, 0)
  }, [deck, tape, nowId, pb.isPlaying, landTrack])

  // REC pressed DOWN (from anywhere — strip or faceplate) while a song
  // is mid-flight → "it records wherever in that song it is": the song
  // lands from the playhead, tail-only (startOffsets).
  const prevArmedRef = useRef(false)
  useEffect(() => {
    const armed = !!deck?.recArmed
    const wasArmed = prevArmedRef.current
    prevArmedRef.current = armed
    if (!armed || wasArmed) return
    if (nowId == null || !pb.isPlaying || getTapeSession()) return
    landTrack(nowId, pb.position * 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck?.recArmed])

  // Where the pen is on the active side right now (effective-time).
  const penMs = useCallback((): number => {
    const d = getDeckState()
    const t = d ? getMixtapes().find((m) => m.id === d.mixtapeId) : undefined
    if (!d || !t) return 0
    const effDur = effectiveDurationFn(durOf, t.startOffsets)
    const ids = tapeTracks(t)
    const idx = nowId != null ? ids.indexOf(nowId) : -1
    // Not on the tape yet = the pen sits at the end of what IS recorded.
    if (idx < 0) return ids.reduce((sum, id) => sum + effDur(id), 0)
    let before = 0
    for (let i = 0; i < idx; i++) before += effDur(ids[i])
    const off = t.startOffsets?.[String(nowId)] || 0
    return before + Math.max(0, pb.position * 1000 - off)
  }, [durOf, nowId, pb.position])

  // ── MIC engine: REC down + MIC on = the mic is HOT — even in silence
  // (Jake: "if i record before the tape it needs to be a part of the
  // tape"). A take with music under it lands as a talkover at its pin;
  // a take spoken onto the head of a blank Side A becomes the tape's
  // OPENING (the voice before track 1 — leader tape, part of the tape
  // on playback and on every dub). ──
  const micShouldRun = !!deck?.micOn && !!deck?.recArmed
  useEffect(() => {
    let cancelled = false
    if (micShouldRun && !micRecRef.current) {
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          })
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
          micStreamRef.current = stream
          micChunksRef.current = []
          const d = getDeckState()
          micPinRef.current = { atMs: penMs() }
          const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
          micRecRef.current = rec
          rec.ondataavailable = (e) => { if (e.data.size > 0) micChunksRef.current.push(e.data) }
          rec.onstop = async () => {
            micStreamRef.current?.getTracks().forEach((t) => t.stop())
            micStreamRef.current = null
            micRecRef.current = null
            setMicCapturing(false)
            try {
              const blob = new Blob(micChunksRef.current, { type: 'audio/webm' })
              if (blob.size < 2000) return // a blip, not a take
              const buf = await blob.arrayBuffer()
              const r = await window.electronAPI.saveMixtapeIntro?.(buf, getDeckState()?.micVoiceId)
              const pin = micPinRef.current
              const d2 = getDeckState()
              if (r?.ok && r.path && pin && d2) {
                const fresh = getMixtapes().find((m) => m.id === d2.mixtapeId)
                if (fresh) {
                  // Spoken onto the head of a blank tape → the tape's
                  // opening, not an overlay. Anything else → talkover.
                  if (tapeTracks(fresh).length === 0 && pin.atMs <= 500) {
                    await persist({ ...fresh, introPath: r.path })
                    flash('Your voice opens the tape — it plays before track 1, always.')
                  } else {
                    await persist({ ...fresh, talkovers: [...(fresh.talkovers || []), { side: 'A', atMs: pin.atMs, path: r.path }] })
                    flash(`Voice on tape at ${fmt(pin.atMs)}.`)
                  }
                }
              }
            } catch (err) { console.warn('[deck-mic] talkover save failed:', err) }
          }
          rec.start()
          setMicCapturing(true)
        } catch {
          flash('Microphone unavailable — check System Settings → Privacy → Microphone.')
          const d = getDeckState()
          if (d) setDeckState({ ...d, micOn: false })
        }
      })()
    } else if (!micShouldRun && micRecRef.current) {
      if (micRecRef.current.state === 'recording') micRecRef.current.stop()
    }
    return () => { cancelled = true }
  }, [micShouldRun, penMs, persist])

  // ── Tape off the radio: while REC is down, WJLR's DJ breaks land on
  // the tape as talkovers pinned right where the tape is — songs land
  // via record-on-play, the DJ lands here. Taping off the air, 1996. ──
  useEffect(() => {
    const onRadioSegment = (e: Event) => {
      const d = getDeckState()
      if (!d?.recArmed) return
      const audioData = (e as CustomEvent<{ audioData?: string }>).detail?.audioData
      if (!audioData) return
      const pin = { side: d.side, atMs: penMs() }
      void (async () => {
        try {
          const bin = atob(audioData)
          const buf = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
          const r = await window.electronAPI.saveMixtapeIntro?.(buf.buffer)
          const d2 = getDeckState()
          if (r?.ok && r.path && d2) {
            const fresh = getMixtapes().find((m) => m.id === d2.mixtapeId)
            if (fresh) {
              if (tapeTracks(fresh).length === 0 && pin.atMs <= 500) {
                await persist({ ...fresh, introPath: r.path })
                flash('Taped the DJ off the air — opens the tape.')
              } else {
                // Talkovers pin to a spot on the ONE tape now; 'A' is written
                // only to satisfy the legacy field shape.
                await persist({ ...fresh, talkovers: [...(fresh.talkovers || []), { side: 'A', atMs: pin.atMs, path: r.path }] })
                flash(`Taped the DJ off the air at ${fmt(pin.atMs)}.`)
              }
            }
          }
        } catch (err) { console.warn('[deck] radio-segment tape failed:', err) }
      })()
    }
    window.addEventListener('jaketunes-radio-segment', onRadioSegment)
    return () => window.removeEventListener('jaketunes-radio-segment', onRadioSegment)
  }, [penMs, persist])

  useEffect(() => () => { // unmount safety
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    if (micRecRef.current && micRecRef.current.state === 'recording') micRecRef.current.stop()
  }, [])

  if (!deck || !tape) return null
  // The faceplate on the tape's own page drives the deck — hide the strip there.
  if (lib.currentView === 'mixtape-detail' && activeMixtapeId === deck.mixtapeId) return null

  const rolling = deck.recArmed && pb.isPlaying
  // The tape's limit is a SONG COUNT now, so the strip reports songs left
  // and total runtime rather than minutes remaining on a side (2026-08-08).
  const counter = liveTapeCounter(tape, nowId, pb.position, pb.isPlaying, durOf)
  const dispLeft = Math.max(0, counter.totalMs - counter.elapsedMs)

  const pressRec = () => {
    mechanicalSound('rec')
    setDeckState({ ...deck, recArmed: !deck.recArmed })
  }

  return (
    <div className={`deckbar${rolling ? ' deckbar--recording' : deck.recArmed ? ' deckbar--armed' : ''}`}>
      <svg className={`deckbar-cassette${rolling ? ' deckbar-cassette--rolling' : ''}`} viewBox="0 0 84 52" width="84" height="52">
      <rect x="1" y="1" width="82" height="50" rx="6" fill="#3a3a3a" stroke="#111" />
        <rect x="7" y="5" width="70" height="16" rx="2" fill="#f4eeda" />
        <text x="42" y="17" textAnchor="middle" fill={tape.inkColor || '#1d3f8f'} className="deckbar-cassette-title">{tape.title.slice(0, 14)}</text>
        <g className="deckbar-spool" style={{ transformOrigin: '28px 36px' }}>
          <circle cx="28" cy="36" r="9" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="1.4" />
          {[0, 120, 240].map((a) => <rect key={a} x="27.2" y="28.5" width="1.6" height="4" fill="#8a8a8a" transform={`rotate(${a} 28 36)`} />)}
        </g>
        <g className="deckbar-spool" style={{ transformOrigin: '56px 36px' }}>
          <circle cx="56" cy="36" r="9" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="1.4" />
          {[0, 120, 240].map((a) => <rect key={a} x="55.2" y="28.5" width="1.6" height="4" fill="#8a8a8a" transform={`rotate(${a} 56 36)`} />)}
        </g>
      </svg>

      <div className="deckbar-counter">
        <span className="deckbar-status">
          {rolling ? '● RECORDING' : deck.recArmed ? 'REC DOWN — press play' : 'not recording'}
        </span>
        <span className="deckbar-side">
          {counter.songs}/{counter.maxSongs} songs
          {counter.songsLeft === 0 ? ' · tape full' : ` · ${fmt(counter.totalMs)} long`}
        </span>
        {rolling && pb.nowPlaying && (
          <span className="deckbar-nowrec">
            {String(pb.nowPlaying.title || '').slice(0, 34)} → tape
            {counter.songsLeft === 0 ? ' — that fills it' : ` — ${counter.songsLeft} left`}
            {micCapturing ? ' · MIC LIVE' : ''}
          </span>
        )}
        {notice && <span className="deckbar-notice">{notice}</span>}
      </div>

      <div className="deckbar-transport">
        <button
          className="deckbar-btn deckbar-btn--play"
          onClick={() => { if (pb.isPlaying) tapeMotorPause(togglePlayPause); else { mechanicalSound('play'); togglePlayPause() } }}
          title={pb.isPlaying ? 'Pause the music' : 'Play the music'}
        >{pb.isPlaying ? <PauseIcon /> : <PlayIcon />}</button>
        <button
          className={`deckbar-btn deckbar-btn--rec${deck.recArmed ? ' is-armed' : ''}`}
          onClick={pressRec}
          title={deck.recArmed ? 'Pop REC out — stop recording (music keeps playing)' : 'Press REC — records from right here'}
        ><RecIcon /> REC</button>
      </div>

      <div className="deckbar-minor">
        <button
          className={`deckbar-mini${deck.micOn ? ' is-talking' : ''}`}
          onClick={() => { mechanicalSound('mic'); setDeckState({ ...deck, micOn: !deck.micOn }) }}
          title={deck.micOn ? 'Mic is ON — it records onto the tape while REC is down' : 'Mic on (records only while REC is down)'}
        ><MicSmallIcon /></button>
        <button className="deckbar-mini deckbar-mini--eject" onClick={() => { mechanicalSound('eject'); setDeckState(null) }} title="Eject the tape">⏏</button>
      </div>
    </div>
  )
}

function PlayIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z" fill="currentColor" /></svg>
}
function PauseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" fill="currentColor" /><rect x="9" y="2" width="4" height="12" fill="currentColor" /></svg>
}
function RecIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor" /></svg>
}
function MicSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  )
}
