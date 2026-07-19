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
import { fitSide, effectiveDurationFn } from '../../common/tape-physics'
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
  const micPinRef = useRef<{ side: 'A' | 'B'; atMs: number } | null>(null)

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
    let t = d ? getMixtapes().find((m) => m.id === d.mixtapeId) : undefined
    if (!d || !t) return
    // THE TAPE IS LINEAR (Jake: "preestablishing songs on side A and B is
    // dumb... side A of the tape is still recording!!"). A song already
    // on the recorded portion (the active side, or anything once we're on
    // B) is physically on tape — skip. But a song only PLANNED for later
    // (sitting in Side B's plan while A is still rolling) yields to
    // reality: pull it out of the plan and record it right here.
    if (d.side === 'A') {
      if (t.sideA.includes(id)) return // already recorded on A
      if (t.sideB.includes(id)) {
        const remaining = t.sideB.filter((x) => x !== id)
        const refit = fitSide(remaining, effectiveDurationFn(durOf, t.startOffsets), (t.tapeLength / 2) * 60_000)
        t = { ...t, sideB: refit.ids, sideBCutMs: refit.cutMs }
      }
    } else {
      if (t.sideA.includes(id) || t.sideB.includes(id)) return // all recorded territory on side B
    }
    const budget = (t.tapeLength / 2) * 60_000
    const offsets = { ...(t.startOffsets || {}) }
    if (startMs > 1500) offsets[String(id)] = Math.round(startMs)
    const effDur = effectiveDurationFn(durOf, offsets)

    const tryLand = (side: 'A' | 'B'): Mixtape | null => {
      const ids = side === 'A' ? t.sideA : t.sideB
      const cut = side === 'A' ? t.sideACutMs : t.sideBCutMs
      if (cut !== undefined) return null
      const fit = fitSide([...ids, id], effDur, budget)
      if (!fit.ids.includes(id)) return null
      const next: Mixtape = { ...t, startOffsets: offsets }
      if (side === 'A') { next.sideA = fit.ids; next.sideACutMs = fit.cutMs }
      else { next.sideB = fit.ids; next.sideBCutMs = fit.cutMs }
      return next
    }

    let sideUsed: 'A' | 'B' = d.side
    let landed = tryLand(d.side)
    if (!landed && d.side === 'A') { landed = tryLand('B'); sideUsed = 'B' }
    if (!landed) {
      setDeckState({ ...d, recArmed: false })
      flash('Tape full — REC popped out.')
      return
    }
    lastLandedRef.current = id
    const cutHere = sideUsed === 'A' ? landed.sideACutMs : landed.sideBCutMs
    const title = lib.tracks.find((x) => x.id === id)?.title || 'song'
    if (cutHere !== undefined) {
      if (sideUsed === 'A') {
        setDeckState({ ...d, side: 'B', recArmed: true })
        flash(`Side A runs out ${fmt(cutHere)} into “${title}” — flipping to B.`)
      } else {
        setDeckState({ ...d, side: 'B' })
        flash(`Side B runs out ${fmt(cutHere)} into “${title}” — that's the tape.`)
      }
    } else if (sideUsed !== d.side) {
      setDeckState({ ...d, side: sideUsed })
    }
    void persist(landed)
  }, [durOf, lib.tracks, persist])

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
    const ids = d.side === 'A' ? t.sideA : t.sideB
    const idx = nowId != null ? ids.indexOf(nowId) : -1
    if (idx < 0) return fitSide(ids, effDur, (t.tapeLength / 2) * 60_000).usedMs
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
          micPinRef.current = { side: d?.side || 'A', atMs: penMs() }
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
                  // Spoken onto the head of a blank Side A → the tape's
                  // opening, not an overlay. Anything else → talkover.
                  if (pin.side === 'A' && fresh.sideA.length === 0 && pin.atMs <= 500) {
                    await persist({ ...fresh, introPath: r.path })
                    flash('Your voice opens the tape — it plays before track 1, always.')
                  } else {
                    await persist({ ...fresh, talkovers: [...(fresh.talkovers || []), { side: pin.side, atMs: pin.atMs, path: r.path }] })
                    flash(`Voice on tape at ${fmt(pin.atMs)}, Side ${pin.side}.`)
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

  useEffect(() => () => { // unmount safety
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    if (micRecRef.current && micRecRef.current.state === 'recording') micRecRef.current.stop()
  }, [])

  if (!deck || !tape) return null
  // The faceplate on the tape's own page drives the deck — hide the strip there.
  if (lib.currentView === 'mixtape-detail' && activeMixtapeId === deck.mixtapeId) return null

  const rolling = deck.recArmed && pb.isPlaying
  const counter = liveTapeCounter(tape, deck.side, nowId, pb.position, pb.isPlaying, durOf)
  const dispSide = counter.side
  // Recording counts the physical tape; playback counts the music.
  const dispLeft = deck.recArmed ? counter.leftMs : Math.max(0, counter.contentMs - counter.usedMs)
  const cutCountdown = counter.cutCountdown

  const pressRec = () => {
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
        <span className="deckbar-side">SIDE {dispSide} · {dispLeft <= 0 ? 'full' : `${fmt(dispLeft)} left`}</span>
        {rolling && pb.nowPlaying && (
          <span className="deckbar-nowrec">
            {String(pb.nowPlaying.title || '').slice(0, 34)} → tape
            {cutCountdown ? ` — ends when the tape does (${fmt(dispLeft)})` : ''}
            {micCapturing ? ' · MIC LIVE' : ''}
          </span>
        )}
        {notice && <span className="deckbar-notice">{notice}</span>}
      </div>

      <div className="deckbar-transport">
        <button
          className="deckbar-btn deckbar-btn--play"
          onClick={togglePlayPause}
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
          onClick={() => setDeckState({ ...deck, micOn: !deck.micOn })}
          title={deck.micOn ? 'Mic is ON — it records onto the tape while REC is down' : 'Mic on (records only while REC is down)'}
        ><MicSmallIcon /></button>
        <button className="deckbar-mini deckbar-mini--eject" onClick={() => setDeckState(null)} title="Eject the tape">⏏</button>
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
