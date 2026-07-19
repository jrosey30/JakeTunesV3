/**
 * DeckBar — the tape recorder (Jake: "play means play, record means tape
 * means record tape... the play/pause and record/dont record buttons are
 * the two most important ones here....thats how mixtapes are made!!").
 *
 * A tape sits in the deck. Two big buttons run the show:
 *   ⏯  PLAY/PAUSE — the music, the normal transport
 *   ⏺  REC — armed (red) = every song that PLAYS is laid onto the
 *      active side, in the order you play it, TRUE physics: the side
 *      fills, the boundary song gets cut, the deck auto-flips to Side B,
 *      and when the whole tape is full REC pops out. Not armed = play
 *      all you want, nothing lands.
 *   TALK — hold a thought? press it while recording and your voice goes
 *      down WITH the music (1979 chain), pinned right at this spot on
 *      the tape. Press again to stop.
 * EJECT takes the tape out. Every landing persists immediately — there
 * is no undo, only taping over.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import {
  getDeckState, setDeckState, getMixtapes, getTapeSession,
  subscribeMixtapes, refreshMixtapes,
} from '../mixtapes'
import { fitSide, MIN_CUT_MS } from '../../common/tape-physics'
import type { Mixtape } from '../types'
import '../styles/mixtape.css'

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function DeckBar() {
  const { state: lib } = useLibrary()
  const { state: pb } = usePlayback()
  // THE transport — same function the toolbar uses, so play/pause stays
  // loyal to the actual audio engine (a raw dispatch only flips the
  // label while the music keeps going — the original sin here).
  const { togglePlayPause } = useAudio()
  const deck = useSyncExternalStore(subscribeMixtapes, getDeckState)
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  const [notice, setNotice] = useState('')
  const [talking, setTalking] = useState(false)
  const [talkBusy, setTalkBusy] = useState(false)
  const lastLandedRef = useRef<number | null>(null)
  const talkRecRef = useRef<MediaRecorder | null>(null)
  const talkStreamRef = useRef<MediaStream | null>(null)
  const talkChunksRef = useRef<Blob[]>([])
  const talkAtRef = useRef<{ side: 'A' | 'B'; atMs: number } | null>(null)

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

  // ── record-on-play: the heart of the deck ─────────────────────────
  const nowId = pb.nowPlaying?.id
  useEffect(() => {
    if (!deck?.recArmed || !tape || nowId == null || !pb.isPlaying) return
    if (getTapeSession()) return            // playing the tape itself — a deck can't dub itself
    if (lastLandedRef.current === nowId) return
    const budget = (tape.tapeLength / 2) * 60_000

    const tryLand = (side: 'A' | 'B'): { tape: Mixtape; flipped: boolean } | 'full' => {
      const ids = side === 'A' ? tape.sideA : tape.sideB
      const cut = side === 'A' ? tape.sideACutMs : tape.sideBCutMs
      if (cut !== undefined) return 'full'  // side already ends mid-song
      const fit = fitSide([...ids, nowId], durOf, budget)
      if (!fit.ids.includes(nowId)) return 'full' // < MIN_CUT_MS left — song never starts
      const next: Mixtape = { ...tape }
      if (side === 'A') { next.sideA = fit.ids; next.sideACutMs = fit.cutMs }
      else { next.sideB = fit.ids; next.sideBCutMs = fit.cutMs }
      return { tape: next, flipped: fit.cutMs !== undefined }
    }

    let landed = tryLand(deck.side)
    let sideUsed: 'A' | 'B' = deck.side
    if (landed === 'full' && deck.side === 'A') {
      landed = tryLand('B')
      sideUsed = 'B'
      if (landed !== 'full') setDeckState({ ...deck, side: 'B' })
    }
    if (landed === 'full') {
      setDeckState({ ...deck, recArmed: false })
      flash('Tape full — REC popped out.')
      return
    }
    lastLandedRef.current = nowId
    const cutHere = sideUsed === 'A' ? landed.tape.sideACutMs : landed.tape.sideBCutMs
    if (cutHere !== undefined) {
      // This song is the boundary — it records until the tape runs out.
      if (sideUsed === 'A') {
        setDeckState({ mixtapeId: deck.mixtapeId, side: 'B', recArmed: true })
        flash(`Side A ran out ${fmt(cutHere)} into “${pb.nowPlaying?.title}” — flipped to B.`)
      } else {
        flash(`Side B ran out ${fmt(cutHere)} into “${pb.nowPlaying?.title}” — that's the tape.`)
      }
    }
    void persist(landed.tape)
  }, [deck, tape, nowId, pb.isPlaying, durOf, persist, pb.nowPlaying?.title])

  const stopTalk = useCallback(() => {
    if (talkRecRef.current && talkRecRef.current.state === 'recording') talkRecRef.current.stop()
  }, [])

  useEffect(() => () => { // unmount safety: kill mic + stream
    talkStreamRef.current?.getTracks().forEach((t) => t.stop())
    if (talkRecRef.current && talkRecRef.current.state === 'recording') talkRecRef.current.stop()
  }, [])

  if (!deck || !tape) return null

  const budget = (tape.tapeLength / 2) * 60_000
  const sideIds = deck.side === 'A' ? tape.sideA : tape.sideB
  const sideCut = deck.side === 'A' ? tape.sideACutMs : tape.sideBCutMs
  const fit = fitSide(sideIds, durOf, budget)
  const leftMs = sideCut !== undefined ? 0 : budget - fit.usedMs
  const rolling = deck.recArmed && pb.isPlaying

  // Where the pen is on the tape right now: everything landed on this
  // side before the current song, plus how far the current song is in.
  const penMs = (): number => {
    const idx = nowId != null ? sideIds.indexOf(nowId) : -1
    if (idx < 0) return fit.usedMs
    let before = 0
    for (let i = 0; i < idx; i++) before += durOf(sideIds[i]) || 210_000
    return before + pb.position * 1000
  }

  const startTalk = async () => {
    if (talking || talkBusy) { stopTalk(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      talkStreamRef.current = stream
      talkChunksRef.current = []
      talkAtRef.current = { side: deck.side, atMs: penMs() }
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      talkRecRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size > 0) talkChunksRef.current.push(e.data) }
      rec.onstop = async () => {
        talkStreamRef.current?.getTracks().forEach((t) => t.stop())
        talkStreamRef.current = null
        setTalking(false)
        setTalkBusy(true)
        try {
          const blob = new Blob(talkChunksRef.current, { type: 'audio/webm' })
          const buf = await blob.arrayBuffer()
          const r = await window.electronAPI.saveMixtapeIntro?.(buf)
          const at = talkAtRef.current
          if (r?.ok && r.path && at) {
            const fresh = getMixtapes().find((m) => m.id === deck.mixtapeId)
            if (fresh) {
              await persist({ ...fresh, talkovers: [...(fresh.talkovers || []), { side: at.side, atMs: at.atMs, path: r.path }] })
              flash(`Your voice is on the tape at ${fmt(at.atMs)} (Side ${at.side}).`)
            }
          } else if (r?.error) flash(r.error)
        } catch (err) {
          flash(String(err))
        }
        setTalkBusy(false)
      }
      rec.start()
      setTalking(true)
    } catch {
      flash('Microphone unavailable — check System Settings → Privacy → Microphone.')
    }
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
        <span className="deckbar-side">SIDE {deck.side} · {sideCut !== undefined || leftMs <= MIN_CUT_MS ? 'full' : `${fmt(leftMs)} left`}</span>
        {rolling && pb.nowPlaying && (
          <span className="deckbar-nowrec">{String(pb.nowPlaying.title || '').slice(0, 34)} → tape</span>
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
          onClick={() => { lastLandedRef.current = deck.recArmed ? lastLandedRef.current : nowId ?? null; setDeckState({ ...deck, recArmed: !deck.recArmed }) }}
          title={deck.recArmed ? 'Pop REC out — stop recording' : 'Press REC — whatever plays goes on the tape'}
        ><RecIcon /> REC</button>
      </div>

      <div className="deckbar-minor">
        <button
          className={`deckbar-mini${talking ? ' is-talking' : ''}`}
          onClick={() => { void startTalk() }}
          disabled={talkBusy}
          title="Talk onto the tape — your voice goes down with the music. Click again to stop."
        ><MicSmallIcon /></button>
        <button className="deckbar-mini deckbar-mini--eject" onClick={() => { stopTalk(); setDeckState(null) }} title="Eject the tape">⏏</button>
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
