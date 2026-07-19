/**
 * MixtapeSheet — turn a selection of songs into a real cassette.
 * Step 1: pick the tape (C60/C90/C120), optional dedication + note,
 * optionally record the voice intro (1979 treatment, previewable).
 * Step 2: Music Man sequences Side A/B to FIT the tape, names it, writes
 * liner notes → preview → Save. Build is a PROPOSAL (nothing persists
 * until Save — same review-gate contract as Activity Sync).
 */
import { useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import MixtapeMic from './MixtapeMic'
import { refreshMixtapes, setMixtapeId, pickInk } from '../mixtapes'
import type { Track, Mixtape } from '../types'
import '../styles/activity-sheet.css'
import '../styles/mixtape.css'

interface Props {
  tracks: Track[]
  onClose: () => void
}

type Stage = 'setup' | 'building' | 'preview'

const TAPES: Array<{ len: 60 | 90 | 120; hint: string }> = [
  { len: 60, hint: '2 × 30 min' },
  { len: 90, hint: '2 × 45 min' },
  { len: 120, hint: '2 × 60 min' },
]

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MixtapeSheet({ tracks, onClose }: Props) {
  const { dispatch } = useLibrary()
  const [stage, setStage] = useState<Stage>('setup')
  const [tapeLength, setTapeLength] = useState<60 | 90 | 120>(90)
  const [dedication, setDedication] = useState('')
  const [note, setNote] = useState('')
  const [introPath, setIntroPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [proposal, setProposal] = useState<{
    title: string
    commentary: string
    sideA: number[]
    sideB: number[]
    linerNotes: Array<{ id: number; note: string }>
    leftovers: number[]
  } | null>(null)

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const totalMs = useMemo(() => tracks.reduce((s, t) => s + (t.duration || 0), 0), [tracks])

  const build = async () => {
    setStage('building')
    setError('')
    try {
      const input = tracks.map((t) => ({
        id: t.id, title: t.title, artist: t.artist, album: t.album,
        genre: t.genre, bpm: t.bpm, duration: t.duration,
        playCount: t.playCount, rating: t.rating,
      }))
      const r = await window.electronAPI.buildMixtape?.(input, tapeLength, dedication.trim() || undefined, note.trim() || undefined)
      if (!r?.ok || !r.sideA) {
        setError(r?.error || 'Music Man dropped the tape — try again.')
        setStage('setup')
        return
      }
      setProposal({
        title: r.title || 'Mixtape',
        commentary: r.commentary || '',
        sideA: r.sideA,
        sideB: r.sideB || [],
        linerNotes: r.linerNotes || [],
        leftovers: r.leftovers || [],
      })
      setStage('preview')
    } catch (err) {
      setError(String(err))
      setStage('setup')
    }
  }

  const save = async () => {
    if (!proposal) return
    const id = `mix-${Date.now().toString(36)}`
    const tape: Mixtape = {
      id,
      title: proposal.title,
      commentary: proposal.commentary,
      dedication: dedication.trim() || undefined,
      tapeLength,
      sideA: proposal.sideA,
      sideB: proposal.sideB,
      linerNotes: proposal.linerNotes,
      introPath: introPath || undefined,
      createdAt: new Date().toISOString(),
      inkColor: pickInk(id),
    }
    const r = await window.electronAPI.saveMixtape?.(tape)
    if (!r?.ok) {
      setError(r?.error || 'Could not save the tape.')
      return
    }
    await refreshMixtapes()
    setMixtapeId(id)
    dispatch({ type: 'SET_VIEW', view: 'mixtape-detail' })
    onClose()
  }

  const sideList = (label: 'A' | 'B', ids: number[]) => {
    const dur = ids.reduce((s, tid) => s + (byId.get(tid)?.duration || 0), 0)
    return (
      <div className="mixsheet-side">
        <div className="mixsheet-side-head">SIDE {label} <span>{fmt(dur)}</span></div>
        {ids.map((tid, i) => {
          const t = byId.get(tid)
          return (
            <div key={tid} className="mixsheet-row">
              <span className="mixsheet-row-num">{i + 1}.</span>
              <span className="mixsheet-row-title">{t?.title || `#${tid}`}</span>
              <span className="mixsheet-row-artist">{t?.artist || ''}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="activity-sheet-overlay" role="dialog" aria-modal="true" aria-label="Make a mixtape">
      <div className="activity-sheet mixsheet">
        {stage === 'setup' && (
          <>
            <div className="activity-sheet-head">
              <h2 className="activity-sheet-title">Make a mixtape</h2>
              <p className="activity-sheet-sub">
                {tracks.length} songs · {fmt(totalMs)} of music. Music Man sequences the two sides so they FIT the tape — if it's too much, the best tape wins and the rest stays off.
              </p>
            </div>
            <div className="activity-q">
              <span className="activity-q-label">The tape</span>
              <div className="activity-chips">
                {TAPES.map(({ len, hint }) => (
                  <button key={len} type="button"
                    className={`activity-chip${tapeLength === len ? ' is-on' : ''}`}
                    onClick={() => setTapeLength(len)}
                  >C{len} <small>({hint})</small></button>
                ))}
              </div>
            </div>
            <div className="activity-q">
              <span className="activity-q-label">For… (optional)</span>
              <input className="activity-place" type="text" value={dedication}
                onChange={(e) => setDedication(e.target.value)}
                placeholder="who or what this tape is for — shapes the title and mood" />
            </div>
            <div className="activity-q">
              <span className="activity-q-label">Anything else?</span>
              <input className="activity-place" type="text" value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional — start slow, end huge; no ballads; make side B weird…" />
            </div>
            <div className="activity-q">
              <span className="activity-q-label">Your voice on the tape</span>
              <MixtapeMic existingPath={introPath || undefined} onProcessed={setIntroPath} />
            </div>
            {error && <div className="mixsheet-error">{error}</div>}
            <div className="activity-sheet-actions">
              <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="activity-btn activity-btn--go" onClick={() => { void build() }}>
                Have Music Man make the tape
              </button>
            </div>
          </>
        )}

        {stage === 'building' && (
          <div className="mixsheet-building">
            <CassetteSpinner />
            <p>Music Man is hunched over the deck, sequencing your tape…</p>
          </div>
        )}

        {stage === 'preview' && proposal && (
          <>
            <div className="activity-sheet-head">
              <h2 className="activity-sheet-title">“{proposal.title}”</h2>
              <p className="activity-sheet-sub">{proposal.commentary}</p>
              {proposal.leftovers.length > 0 && (
                <p className="mixsheet-leftovers">
                  Didn't fit the C{tapeLength}: {proposal.leftovers.slice(0, 6).map((tid) => byId.get(tid)?.title || `#${tid}`).join(', ')}
                  {proposal.leftovers.length > 6 ? ` +${proposal.leftovers.length - 6} more` : ''}
                </p>
              )}
            </div>
            <div className="mixsheet-sides">
              {sideList('A', proposal.sideA)}
              {sideList('B', proposal.sideB)}
            </div>
            {error && <div className="mixsheet-error">{error}</div>}
            <div className="activity-sheet-actions">
              <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="activity-btn activity-btn--ghost" onClick={() => { void build() }}>Re-roll</button>
              <button type="button" className="activity-btn activity-btn--go" onClick={() => { void save() }}>Save Tape</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CassetteSpinner() {
  return (
    <svg width="120" height="76" viewBox="0 0 120 76">
      <rect x="2" y="2" width="116" height="72" rx="8" fill="#3a3a3a" stroke="#111" />
      <rect x="10" y="8" width="100" height="26" rx="3" fill="#f4eeda" />
      <g style={{ transformOrigin: '40px 52px' }} className="spool--spin">
        <circle cx="40" cy="52" r="12" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="1.5" />
        {[0, 120, 240].map((a) => <rect key={a} x="39" y="42" width="2" height="5" fill="#8a8a8a" transform={`rotate(${a} 40 52)`} />)}
      </g>
      <g style={{ transformOrigin: '80px 52px' }} className="spool--spin">
        <circle cx="80" cy="52" r="12" fill="#0e0e0e" stroke="#4a4a4a" strokeWidth="1.5" />
        {[0, 120, 240].map((a) => <rect key={a} x="79" y="42" width="2" height="5" fill="#8a8a8a" transform={`rotate(${a} 80 52)`} />)}
      </g>
    </svg>
  )
}
