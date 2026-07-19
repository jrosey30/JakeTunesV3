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
import MixtapeMic from '../components/MixtapeMic'
import { getMixtapeId, getMixtapes, subscribeMixtapes, refreshMixtapes, pickInk } from '../mixtapes'
import type { Track, Mixtape } from '../types'
import '../styles/mixtape.css'

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function CassetteSvg({ title, ink, lengthLabel, spinning, side }: {
  title: string
  ink: string
  lengthLabel: string
  spinning: boolean
  side: 'A' | 'B' | null
}) {
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
      <g className={spinning ? 'spool spool--spin' : 'spool'} style={{ transformOrigin: '110px 138px' }}>
        <circle cx="110" cy="138" r="20" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="2" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <rect key={a} x="108.5" y="122" width="3" height="8" fill="#8a8a8a" transform={`rotate(${a} 110 138)`} />
        ))}
      </g>
      <g className={spinning ? 'spool spool--spin' : 'spool'} style={{ transformOrigin: '210px 138px' }}>
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
  const { playTrack } = useAudio()
  const mixtapes = useSyncExternalStore(subscribeMixtapes, getMixtapes)
  const mixtapeId = useSyncExternalStore(subscribeMixtapes, getMixtapeId)
  const [confirmDelete, setConfirmDelete] = useState(false)
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

  const stopIntro = useCallback(() => {
    if (introRef.current) { introRef.current.pause(); introRef.current = null }
    setIntroPlaying(false)
  }, [])

  const startQueueAt = useCallback((idx: number) => {
    stopIntro()
    const t = allTracks[idx]
    if (t) playTrack(t, allTracks, idx, undefined, true)
  }, [allTracks, playTrack, stopIntro])

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
  const durA = sideATracks.reduce((s, t) => s + (t.duration || 0), 0)
  const durB = sideBTracks.reduce((s, t) => s + (t.duration || 0), 0)
  const sideBudget = (tape.tapeLength / 2) * 60_000

  const renderSide = (label: 'A' | 'B', tracks: Track[], startIdx: number, dur: number) => (
    <div className="jcard-side">
      <div className="jcard-side-head">
        <span className="jcard-side-label" style={{ color: ink }}>SIDE {label}</span>
        <span className="jcard-side-time">{fmt(dur)} of {fmt(sideBudget)}</span>
      </div>
      {tracks.map((t, i) => {
        const isNow = currentId === t.id
        return (
          <div key={t.id} className={`jcard-row${isNow ? ' jcard-row--now' : ''}`}
            onDoubleClick={() => startQueueAt(startIdx + i)} title="Double-click to play from here">
            <span className="jcard-row-num">{i + 1}.</span>
            <span className="jcard-row-title">{t.title}</span>
            <span className="jcard-row-artist">{t.artist}</span>
            <span className="jcard-row-time">{fmt(t.duration || 0)}</span>
            {notes.has(t.id) && <span className="jcard-row-note" style={{ color: ink }}>{notes.get(t.id)}</span>}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="mixtape-view">
      <div className="mixtape-hero">
        <CassetteSvg title={tape.title} ink={ink} lengthLabel={`C${tape.tapeLength}`} spinning={tapeActive} side={side} />
        <div className="mixtape-hero-info">
          <h1 className="mixtape-title">{tape.title}</h1>
          {tape.dedication && <div className="mixtape-dedication" style={{ color: ink }}>for: {tape.dedication}</div>}
          <p className="mixtape-commentary">{tape.commentary}</p>
          <div className="mixtape-actions">
            <button className="mixtape-btn mixtape-btn--play" onClick={playTape} disabled={allTracks.length === 0}>
              {introPlaying ? '⏸ voice on tape…' : '▶ Play Tape'}
            </button>
            {introPlaying && (
              <button className="mixtape-btn" onClick={() => { stopIntro(); startQueueAt(0) }}>Skip intro</button>
            )}
            <button className="mixtape-btn" onClick={() => setConfirmDelete(true)}>Delete Tape</button>
          </div>
          <MixtapeMic
            existingPath={tape.introPath}
            onProcessed={(path) => {
              void window.electronAPI.saveMixtape?.({ ...tape, introPath: path || undefined })
                .then(() => refreshMixtapes())
            }}
          />
        </div>
      </div>

      <div className="jcard">
        {renderSide('A', sideATracks, 0, durA)}
        {renderSide('B', sideBTracks, sideATracks.length, durB)}
      </div>

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
