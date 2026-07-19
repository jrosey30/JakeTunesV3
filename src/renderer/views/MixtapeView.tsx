/**
 * MixtapeView — the cassette itself. Shell + rotating spools + the
 * handwritten label, then the unfolded J-card: dedication, Music Man's
 * blurb, Side A / Side B tracklists with liner-note scribbles.
 *
 * Play Tape: Jake's 1979 intro first (if recorded), then Side A → Side B
 * strictly in order through the normal playback queue. The side indicator
 * and spool animation follow the live playback state.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import ConfirmDialog from '../components/ConfirmDialog'
import MixtapeSheet from '../components/MixtapeSheet'
import { getMixtapeId, getMixtapes, getDeckState, subscribeMixtapes, refreshMixtapes, pickInk, setTapeSession, setDeckState, liveTapeCounter, spoolTarget, setPendingTapeSeek } from '../mixtapes'
import { startWindSound, stopWindSound } from '../tapeDeck'
import { effectiveDurationFn } from '../../common/tape-physics'
import type { Track, Mixtape } from '../types'
import '../styles/mixtape.css'

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function CassetteSvg({ title, ink, lengthLabel, spinning, side, wind }: {
  title: string
  ink: string
  lengthLabel: string
  spinning: boolean
  side: 'A' | 'B' | null
  /** Winding: 1 = FF (fast), -1 = REW (fast, reversed), undefined = normal. */
  wind?: 1 | -1
}) {
  const spoolCls = spinning || wind
    ? `spool spool--spin${wind ? ' spool--fast' : ''}${wind === -1 ? ' spool--rev' : ''}`
    : 'spool'
  return (
    <svg className="cassette" viewBox="0 0 320 200" width="320" height="200">
      {/* shell */}
      <rect x="4" y="4" width="312" height="192" rx="14" fill="#2b2b2b" stroke="#111" strokeWidth="2" />
      <rect x="10" y="10" width="300" height="180" rx="10" fill="#3a3a3a" />
      {/* screws */}
      {[[18, 18], [302, 18], [18, 182], [302, 182]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="4" fill="#1c1c1c" stroke="#555" strokeWidth="1" />
      ))}
      {/* label */}
      <rect x="26" y="22" width="268" height="86" rx="4" fill="#f4eeda" stroke="#c9bfa2" />
      <line x1="38" y1="52" x2="282" y2="52" stroke="#c9bfa2" strokeWidth="1" />
      <line x1="38" y1="72" x2="282" y2="72" stroke="#d8d0b8" strokeWidth="1" />
      <text x="160" y="46" textAnchor="middle" className="cassette-title" fill={ink}>{title}</text>
      <text x="40" y="68" className="cassette-side-mark" fill={ink}>{side ? `SIDE ${side} ▸` : ''}</text>
      <text x="282" y="103" textAnchor="end" className="cassette-len" fill="#6b6045">{lengthLabel}</text>
      {/* window + spools */}
      <rect x="70" y="112" width="180" height="52" rx="26" fill="#181818" stroke="#0c0c0c" />
      <g className={spoolCls} style={{ transformOrigin: '110px 138px' }}>
        <circle cx="110" cy="138" r="20" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="2" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <rect key={a} x="108.5" y="122" width="3" height="8" fill="#8a8a8a" transform={`rotate(${a} 110 138)`} />
        ))}
      </g>
      <g className={spoolCls} style={{ transformOrigin: '210px 138px' }}>
        <circle cx="210" cy="138" r="20" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="2" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <rect key={a} x="208.5" y="122" width="3" height="8" fill="#8a8a8a" transform={`rotate(${a} 210 138)`} />
        ))}
      </g>
      {/* tape between spools */}
      <rect x="128" y="134" width="64" height="8" rx="3" fill="#5c4a32" />
      {/* bottom holes */}
      <rect x="120" y="172" width="80" height="14" rx="4" fill="#242424" stroke="#141414" />
      <circle cx="134" cy="179" r="3.5" fill="#0c0c0c" />
      <circle cx="186" cy="179" r="3.5" fill="#0c0c0c" />
    </svg>
  )
}

export default function MixtapeView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack, togglePlayPause, stopPlayback, seek } = useAudio()
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  const mixtapeId = useSyncExternalStore(subscribeMixtapes, getMixtapeId)
  const deckState = useSyncExternalStore(subscribeMixtapes, getDeckState)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [remixing, setRemixing] = useState(false)
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    window.electronAPI.listMixtapeVoices?.().then((r) => { if (r?.ok) setVoices(r.voices) }).catch(() => {})
  }, [])
  const [dubbing, setDubbing] = useState(false)
  const [dubNotice, setDubNotice] = useState('')
  const mountRef = useRef<string>('')
  useEffect(() => {
    window.electronAPI?.getMusicLibraryPath?.().then((p: string) => { mountRef.current = p }).catch(() => {})
  }, [])
  const [introPlaying, setIntroPlaying] = useState(false)
  const introRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => { void refreshMixtapes() }, [])
  // Cancel mirrors start: leaving the view kills a playing intro.
  useEffect(() => () => {
    if (introRef.current) { introRef.current.pause(); introRef.current = null }
  }, [])

  const tape: Mixtape | undefined = mixtapes.find((m) => m.id === mixtapeId)

  const byId = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])
  const sideATracks = useMemo(() => (tape?.sideA || []).map((id) => byId.get(id)).filter((t): t is Track => !!t), [tape, byId])
  const sideBTracks = useMemo(() => (tape?.sideB || []).map((id) => byId.get(id)).filter((t): t is Track => !!t), [tape, byId])
  const allTracks = useMemo(() => [...sideATracks, ...sideBTracks], [sideATracks, sideBTracks])
  const notes = useMemo(() => new Map((tape?.linerNotes || []).map((n) => [n.id, n.note])), [tape])

  // SPOOL WIND — holding FF/REW winds the tape for real: the head lifts
  // (playback pauses), the spools accelerate 8x→32x, the deck squeals,
  // and the counter races. Release and playback drops in wherever the
  // ribbon landed — mid-song, next song, wherever. One ribbon.
  const [winding, setWinding] = useState<null | { dir: 1 | -1; side: 'A' | 'B'; usedMs: number }>(null)
  const windTimer = useRef<number | null>(null)
  const windMeta = useRef<{ wasPlaying: boolean; startedAt: number }>({ wasPlaying: false, startedAt: 0 })
  // Leaving the view mid-wind: kill the motor (mirrors start, house rule).
  useEffect(() => () => {
    if (windTimer.current != null) { clearInterval(windTimer.current); windTimer.current = null; stopWindSound() }
  }, [])

  const stopIntro = useCallback(() => {
    if (introRef.current) { introRef.current.pause(); introRef.current = null }
    setIntroPlaying(false)
  }, [])

  const startQueueAt = useCallback((idx: number) => {
    stopIntro()
    const t = allTracks[idx]
    if (!t || !tape) return
    // TRUE tape physics: arm the cut points before the reels move. The
    // Side A cut is the flip; the Side B cut is the end of the tape.
    // A boundary song with a start offset plays from the offset — its
    // cut lands at offset + tape-remaining in SONG time.
    const cutPos = (id: number, cutMs: number) => ((tape.startOffsets?.[String(id)] || 0) + cutMs) / 1000
    const cuts: Array<{ trackId: number; cutSec: number; thenStop: boolean }> = []
    if (tape.sideACutMs && tape.sideA.length > 0) {
      const id = tape.sideA[tape.sideA.length - 1]
      cuts.push({ trackId: id, cutSec: cutPos(id, tape.sideACutMs), thenStop: false })
    }
    if (tape.sideBCutMs && tape.sideB.length > 0) {
      const id = tape.sideB[tape.sideB.length - 1]
      cuts.push({ trackId: id, cutSec: cutPos(id, tape.sideBCutMs), thenStop: true })
    }
    setTapeSession({ mixtapeId: tape.id, tapeTrackIds: allTracks.map((x) => x.id), cuts })
    playTrack(t, allTracks, idx, undefined, true)
  }, [allTracks, playTrack, stopIntro, tape])

  // Dub to a REAL cassette: render each side as one continuous file
  // (cuts honored, intro at the head of A, talkovers mixed at their
  // pins) → ~/Desktop/JakeTunes Dubs/<title>/ → play it into the deck.
  const dubToCassette = async () => {
    if (!tape || dubbing) return
    setDubbing(true)
    setDubNotice('Dubbing… rendering both sides.')
    try {
      const abs = (t: Track) => mountRef.current + String(t.path || '').replace(/:/g, '/')
      const mkSide = (label: 'A' | 'B', tracksOnSide: Track[], cutMs?: number) => ({
        label,
        songs: tracksOnSide.map((t, i) => ({
          absPath: abs(t),
          cutMs: cutMs !== undefined && i === tracksOnSide.length - 1 ? cutMs : undefined,
          startMs: tape.startOffsets?.[String(t.id)] || undefined,
        })),
        talkovers: (tape.talkovers || []).filter((tv) => tv.side === label).map((tv) => ({ atMs: tv.atMs, path: tv.path })),
        introPath: label === 'A' ? tape.introPath : undefined,
      })
      const r = await window.electronAPI.dubMixtape?.({
        title: tape.title,
        sides: [
          mkSide('A', sideATracks, tape.sideACutMs),
          mkSide('B', sideBTracks, tape.sideBCutMs),
        ],
      })
      setDubNotice(r?.ok
        ? `Dubbed to Desktop → JakeTunes Dubs → ${tape.title}. Play a side out the headphone jack, hold REC on the real deck.`
        : (r?.error || 'Dub failed.'))
    } catch (err) {
      setDubNotice(String(err))
    }
    setDubbing(false)
    setTimeout(() => setDubNotice(''), 12_000)
  }

  const playTape = useCallback(() => {
    if (allTracks.length === 0) return
    if (tape?.introPath) {
      stopIntro()
      const a = new Audio('ipod-audio://' + encodeURIComponent(tape.introPath))
      introRef.current = a
      setIntroPlaying(true)
      a.onended = () => { setIntroPlaying(false); introRef.current = null; startQueueAt(0) }
      void a.play().catch(() => { setIntroPlaying(false); introRef.current = null; startQueueAt(0) })
    } else {
      startQueueAt(0)
    }
  }, [allTracks.length, tape, startQueueAt, stopIntro])

  if (!tape) {
    return <div className="mixtape-view"><div className="mixtape-missing">That tape isn't on the shelf anymore.</div></div>
  }

  const ink = tape.inkColor || pickInk(tape.id)
  const currentId = pb.nowPlaying?.id
  const onSideA = currentId != null && tape.sideA.includes(currentId)
  const onSideB = currentId != null && tape.sideB.includes(currentId)
  const tapeActive = introPlaying || ((onSideA || onSideB) && pb.isPlaying)
  const side: 'A' | 'B' | null = introPlaying ? 'A' : onSideA ? 'A' : onSideB ? 'B' : null
  const effDur = effectiveDurationFn((id) => byId.get(id)?.duration || undefined, tape.startOffsets)
  const durA = sideATracks.reduce((s, t) => s + effDur(t.id), 0)
  const durB = sideBTracks.reduce((s, t) => s + effDur(t.id), 0)
  const sideBudget = (tape.tapeLength / 2) * 60_000

  const renderSide = (label: 'A' | 'B', tracks: Track[], startIdx: number, dur: number, cutMs?: number) => (
    <div className="jcard-side">
      <div className="jcard-side-head">
        <span className="jcard-side-label" style={{ color: ink }}>SIDE {label}</span>
        <span className="jcard-side-time">{cutMs ? `full — ${fmt(sideBudget)}` : `${fmt(dur)} of ${fmt(sideBudget)}`}</span>
      </div>
      {tracks.map((t, i) => {
        const isNow = currentId === t.id
        const isCut = !!cutMs && i === tracks.length - 1
        return (
          <div key={t.id} className={`jcard-row${isNow ? ' jcard-row--now' : ''}`}>
            <span className="jcard-row-num">{i + 1}.</span>
            <span className="jcard-row-title">{t.title}</span>
            <span className="jcard-row-artist">{t.artist}</span>
            <span className="jcard-row-time">{isCut ? fmt(cutMs!) : fmt(effDur(t.id))}</span>
            {(tape.startOffsets?.[String(t.id)] || 0) > 0 && (
              <span className="jcard-row-note" style={{ color: ink }}>picked up mid-song — from {fmt(tape.startOffsets![String(t.id)])}</span>
            )}
            {notes.has(t.id) && <span className="jcard-row-note" style={{ color: ink }}>{notes.get(t.id)}</span>}
            {isCut && <span className="jcard-row-note jcard-row-cut" style={{ color: ink }}>— tape runs out at {fmt(cutMs!)}. too bad.</span>}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="mixtape-view">
      <div className="mixtape-hero">
        <CassetteSvg title={tape.title} ink={ink} lengthLabel={`C${tape.tapeLength}`} spinning={tapeActive} side={side} wind={winding?.dir} />
        <div className="mixtape-hero-info">
          <h1 className="mixtape-title">{tape.title}</h1>
          {tape.dedication && <div className="mixtape-dedication" style={{ color: ink }}>for: {tape.dedication}</div>}
          <p className="mixtape-commentary">{tape.commentary}</p>
          {(() => {
            const loaded = deckState?.mixtapeId === tape.id
            const armed = loaded && !!deckState?.recArmed
            const micOn = loaded && !!deckState?.micOn
            const resumeSide: 'A' | 'B' = tape.sideACutMs !== undefined ? 'B' : 'A'
            const load = (over: { recArmed?: boolean; micOn?: boolean; micVoiceId?: string }) => {
              const cur = getDeckState()
              if (cur?.mixtapeId === tape.id) setDeckState({ ...cur, ...over })
              else setDeckState({ mixtapeId: tape.id, side: resumeSide, recArmed: false, micOn: false, ...over })
            }
            const currentOnTape = currentId != null && (tape.sideA.includes(currentId) || tape.sideB.includes(currentId))
            const pressPlay = () => {
              if (armed) { if (!pb.isPlaying && pb.nowPlaying) togglePlayPause(); return }
              if (currentOnTape) { if (!pb.isPlaying) togglePlayPause(); return }
              playTape()
            }
            // SPOOL WIND — hold FF/REW and the tape WINDS (Jake: "like an
            // actual tape... thats how old mixtapes merge with each other").
            // The head lifts, the spools accelerate, the deck squeals;
            // release and you land wherever the ribbon stopped — straight
            // through the middle of songs. Locked while REC is latched.
            const WIND_TICK = 90
            const startWind = (dir: 1 | -1) => {
              if (armed || winding) return
              const side = counter.side
              const ids = side === 'A' ? tape.sideA : tape.sideB
              const sideTotal = ids.reduce((s, id) => s + effDur(id), 0)
              if (sideTotal <= 0) return
              windMeta.current = { wasPlaying: pb.isPlaying, startedAt: Date.now() }
              if (pb.isPlaying) togglePlayPause()
              startWindSound()
              setWinding({ dir, side, usedMs: counter.usedMs })
              windTimer.current = window.setInterval(() => {
                setWinding((w) => {
                  if (!w) return w
                  const held = (Date.now() - windMeta.current.startedAt) / 1000
                  const speed = Math.min(32, 8 * Math.pow(2, held))
                  const next = w.usedMs + w.dir * speed * WIND_TICK
                  return { ...w, usedMs: Math.max(0, Math.min(sideTotal - 1500, next)) }
                })
              }, WIND_TICK)
            }
            const finishWind = () => {
              if (!winding) return
              if (windTimer.current != null) { clearInterval(windTimer.current); windTimer.current = null }
              stopWindSound()
              const { side, usedMs } = winding
              setWinding(null)
              const durOfId = (id: number) => byId.get(id)?.duration || undefined
              const tgt = spoolTarget(tape, side, usedMs, 0, durOfId)
              if (!tgt) return
              if (currentId === tgt.trackId) {
                const durMs = byId.get(tgt.trackId)?.duration || 0
                if (durMs > 0) seek(Math.min(0.99, tgt.fileSeekMs / durMs))
                if (windMeta.current.wasPlaying && !pb.isPlaying) togglePlayPause()
                return
              }
              // landed past a splice: drop in mid-song on that slot
              const all = [...sideATracks, ...sideBTracks]
              const idx = all.findIndex((t) => t.id === tgt.trackId)
              if (idx < 0) return
              setPendingTapeSeek({ trackId: tgt.trackId, seekMs: tgt.fileSeekMs })
              startQueueAt(idx)
            }
            const rolling = armed && pb.isPlaying
            // The counter window — how much tape is left on this side,
            // rolling live while the tail song records or plays.
            const counter = liveTapeCounter(
              tape,
              loaded ? deckState!.side : resumeSide,
              currentId, pb.position, pb.isPlaying,
              (id) => byId.get(id)?.duration || undefined,
            )
            return (
              <>
                <div className="faceplate">
                  <div className={`fp-counter${rolling || winding ? ' fp-counter--rolling' : ''}`}
                    title="Tape left on this side — rolls while you record">
                    <span className="fp-counter-side">SIDE {winding ? winding.side : counter.side}</span>
                    <span className="fp-counter-digits">
                      {winding
                        ? fmt(Math.max(0, sideBudget - winding.usedMs))
                        : counter.leftMs <= 0 ? 'FULL' : fmt(counter.leftMs)}
                    </span>
                    <span className="fp-counter-sub">
                      {winding ? (winding.dir > 0 ? '›› winding' : '‹‹ winding') : counter.leftMs <= 0 ? 'tape over it' : 'left'}
                    </span>
                  </div>
                  <button className={`fp-key fp-key--rec${armed ? ' is-down' : ''}`} onClick={() => load({ recArmed: !armed })}
                    title="RECORD — whatever plays goes on this tape. Press mid-song and it records from right there.">
                    <span className="fp-shape fp-shape--circle" /><span className="fp-label">REC</span>
                  </button>
                  <button className={`fp-key${winding?.dir === -1 ? ' is-down' : ''}`} disabled={armed}
                    onMouseDown={() => startWind(-1)} onMouseUp={finishWind} onMouseLeave={finishWind}
                    title="REWIND — hold it down and the tape winds back, screaming past the song joins. Let go to drop back in. Locked while REC is down.">
                    <span className="fp-shape fp-shape--rew" /><span className="fp-label">REW</span>
                  </button>
                  <button className="fp-key fp-key--play" onClick={pressPlay}
                    title={armed ? 'PLAY — roll the music you are recording' : 'PLAY — play this tape'}>
                    <span className="fp-shape fp-shape--tri" /><span className="fp-label">PLAY</span>
                  </button>
                  <button className={`fp-key${winding?.dir === 1 ? ' is-down' : ''}`} disabled={armed}
                    onMouseDown={() => startWind(1)} onMouseUp={finishWind} onMouseLeave={finishWind}
                    title="FAST-FORWARD — hold it down and the tape winds ahead, straight through the middle of songs. Let go to drop back in. Locked while REC is down.">
                    <span className="fp-shape fp-shape--ff" /><span className="fp-label">FF</span>
                  </button>
                  <button className="fp-key" onClick={() => { stopPlayback(); if (loaded) load({ recArmed: false, micOn: false }) }}
                    title="STOP — everything stops and the REC latch pops out, like a real deck">
                    <span className="fp-shape fp-shape--stop" /><span className="fp-label">STOP</span>
                  </button>
                  <button className="fp-key fp-key--pause" onClick={() => { if (pb.isPlaying) togglePlayPause() }}
                    title="PAUSE — the music stops where it is. Recording waits.">
                    <span className="fp-shape fp-shape--bars" /><span className="fp-label">PAUSE</span>
                  </button>
                  <button className={`fp-key fp-key--mic${micOn ? ' is-down' : ''}`} onClick={() => load({ micOn: !micOn })}
                    title="MIC — mic on means mic ready. Your voice records onto the tape only while REC is down.">
                    <span className="fp-shape fp-shape--mic"><MicShape /></span><span className="fp-label">MIC</span>
                  </button>
                  <button className="fp-key fp-key--eject" onClick={() => { if (loaded) setDeckState(null) }} disabled={!loaded}
                    title="EJECT — take the tape out of the deck">
                    <span className="fp-shape fp-shape--eject" /><span className="fp-label">EJECT</span>
                  </button>
                </div>
                <div className="fp-voicerow">
                  <span className="fp-voicerow-label">MIC VOICE</span>
                  <select
                    className="fp-voice-select"
                    value={(loaded && deckState?.micVoiceId) || 'me'}
                    onChange={(e) => load({ micVoiceId: e.target.value })}
                    title="Whose voice goes on the tape — yours, or anyone from the station (your take, their voice)"
                  >
                    {(voices.length ? voices : [{ id: 'me', name: 'My voice' }]).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className={`fp-status${rolling ? ' fp-status--recording' : armed ? ' fp-status--armed' : ''}`}>
                  {rolling ? `● RECORDING — ${String(pb.nowPlaying?.title || '').slice(0, 30)} → tape${micOn ? ' · MIC LIVE' : ''}`
                    : armed ? 'REC DOWN — press PLAY'
                    : loaded ? 'in the deck — not recording'
                    : 'on the shelf — press REC to record onto it'}
                </div>
              </>
            )
          })()}
          <div className="mixtape-smallrow">
            <button className="mixtape-link" onClick={() => setRemixing(true)}>Open on the deck</button>
            <span>·</span>
            <button className="mixtape-link" disabled={dubbing} onClick={() => { void dubToCassette() }}>{dubbing ? 'Making the files…' : 'Make Side A + B files for a REAL cassette deck'}</button>
            <span>·</span>
            <button className="mixtape-link" onClick={() => setConfirmDelete(true)}>Delete Tape</button>
          </div>
          {dubNotice && <div className="mixtape-dub-notice">{dubNotice}</div>}
        </div>
      </div>

      <div className="jcard">
        {renderSide('A', sideATracks, 0, durA, tape.sideACutMs)}
        {renderSide('B', sideBTracks, sideATracks.length, durB, tape.sideBCutMs)}
      </div>

      {remixing && (
        <MixtapeSheet tracks={allTracks} existing={tape} onClose={() => { setRemixing(false); void refreshMixtapes() }} />
      )}
      {confirmDelete && (
        <ConfirmDialog
          message={`Throw out “${tape.title}”?`}
          detail="The tape and its recorded intro are deleted. The songs stay in your library."
          confirmLabel="Throw it out"
          onConfirm={() => {
            setConfirmDelete(false)
            void window.electronAPI.deleteMixtape?.(tape.id)
              .then(() => refreshMixtapes())
              .then(() => libDispatch({ type: 'SET_VIEW', view: 'home' }))
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}


function MicShape() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  )
}
