/**
 * MixtapeSheet — the tape deck.
 *
 * Setup: pick the tape by SIDE length (30/30, 45/45, 60/60), dedication,
 * note, record the voice intro. Music Man deals the first cut of the
 * tape — then you land on THE DECK and mix it like it's 1985:
 *   ↑ ↓  nudge a song up/down the side
 *   ⇄    bump it to the other side
 *   ×    off the tape
 * Adding songs happens at the RECORDER (play with REC down) or by
 * right-clicking songs → "Lay on the tape" — not here.
 * The tape counter is live and TRUE (src/common/tape-physics.ts — the
 * exact function the saved tape obeys): each side shows time used, time
 * left, where the boundary song gets cut, and songs stacked past the end
 * show as "didn't record" — they're on the tape order but the tape ran
 * out. No undo anywhere. Save = the tape is dubbed; remixing a saved
 * tape TAPES OVER it (same id, old arrangement gone).
 */
import { useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import MixtapeMic from './MixtapeMic'
import { refreshMixtapes, setMixtapeId, pickInk } from '../mixtapes'
import { effectiveDurationFn, tapeTracks, fitTape, MAX_TAPE_SONGS } from '../../common/tape-physics'
import type { Track, Mixtape } from '../types'
import '../styles/activity-sheet.css'
import '../styles/mixtape.css'

interface Props {
  tracks: Track[]
  onClose: () => void
  /** Remix mode: open a saved tape straight on the deck; Save tapes over it. */
  existing?: Mixtape
}

type Stage = 'setup' | 'building' | 'deck'


function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MixtapeSheet({ tracks, onClose, existing }: Props) {
  const { state: lib, dispatch } = useLibrary()
  const [stage, setStage] = useState<Stage>(existing ? 'deck' : 'setup')
  const [dedication, setDedication] = useState(existing?.dedication ?? '')
  const [note, setNote] = useState('')
  const [introPath, setIntroPath] = useState<string | null>(existing?.introPath ?? null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [commentary, setCommentary] = useState(existing?.commentary ?? '')
  const [linerNotes, setLinerNotes] = useState<Array<{ id: number; note: string }>>(existing?.linerNotes ?? [])
  // The deck: the tape's running order. ONE list since 2026-08-08 — the
  // A/B split and the minutes budget are gone; the only limit is the song
  // count, applied at the edges so the deck can never exceed it.
  const [deck, setDeck] = useState<number[]>(() => (existing ? tapeTracks(existing) : []))

  const libById = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])
  const dur = effectiveDurationFn((id: number) => libById.get(id)?.duration || undefined, existing?.startOffsets)
  const fit = useMemo(() => fitTape(deck), [deck])
  const deckMs = useMemo(() => fit.reduce((sum: number, id: number) => sum + dur(id), 0), [fit, libById])

  const placed = useMemo(() => new Set(deck), [deck])
  // The floor: songs brought to the session but not on either side.
  const floor = useMemo(() => tracks.filter((t) => !placed.has(t.id)), [tracks, placed])

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
      const r = await window.electronAPI.buildMixtape?.(input, dedication.trim() || undefined, note.trim() || undefined)
      if (!r?.ok || !r.tracks) {
        setError(r?.error || 'Music Man dropped the tape — try again.')
        setStage('setup')
        return
      }
      setTitle(r.title || 'Mixtape')
      setCommentary(r.commentary || '')
      setLinerNotes(r.linerNotes || [])
      setDeck(r.tracks)
      setStage('deck')
    } catch (err) {
      setError(String(err))
      setStage('setup')
    }
  }

  const save = async () => {
    if (fit.length < 1) {
      setError('The tape is blank — put at least one song on it.')
      return
    }
    const id = existing?.id ?? `mix-${Date.now().toString(36)}`
    const onTape = new Set(fit)
    const tape: Mixtape = {
      id,
      title: title.trim() || 'Mixtape',
      commentary,
      dedication: dedication.trim() || undefined,
      tracks: fit,
      // Legacy fields the record still carries so old tapes keep reading;
      // a tape made now is one sequence and nothing consults these.
      tapeLength: existing?.tapeLength ?? 90,
      sideA: [],
      sideB: [],
      linerNotes: linerNotes.filter((n) => onTape.has(n.id)),
      introPath: introPath || undefined,
      startOffsets: existing?.startOffsets,
      talkovers: existing?.talkovers,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      inkColor: existing?.inkColor ?? pickInk(id),
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

  // ── deck tools ──────────────────────────────────────────────────────
  // One list now, so "bump to the other side" is gone; nudging and removing
  // are the whole vocabulary (2026-08-08).
  const move = (idx: number, delta: number) => {
    setDeck((cur) => {
      const next = [...cur]
      const j = idx + delta
      if (j < 0 || j >= next.length) return cur
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }
  const drop = (idx: number) => setDeck((cur) => cur.filter((_, i) => i !== idx))

  const renderDeck = () => {
    const over = new Set(deck.slice(MAX_TAPE_SONGS))
    return (
      <div className="mixsheet-side">
        <div className="mixsheet-side-head">
          THE TAPE
          <span className="mixsheet-counter">
            {fit.length}/{MAX_TAPE_SONGS} songs · {fmt(deckMs)}
            {fit.length >= MAX_TAPE_SONGS ? ' · full' : ''}
          </span>
        </div>
        {deck.map((tid, i) => {
          const t = libById.get(tid)
          // Past the cap: still shown, greyed, labelled — same honesty the
          // old overflow rows had when the tape ran out of minutes.
          const isDead = over.has(tid)
          return (
            <div key={tid} className={`mixsheet-row${isDead ? ' mixsheet-row--dead' : ''}`}>
              <span className="mixsheet-row-num">{i + 1}.</span>
              <span className="mixsheet-row-text">
                <span className="mixsheet-row-title">{t?.title || `#${tid}`}</span>
                {t?.artist ? <span className="mixsheet-row-artist">{t.artist}</span> : null}
                {isDead ? <em className="mixsheet-cut-note"> — past {MAX_TAPE_SONGS}, won't record</em> : null}
              </span>
              <span className="mixsheet-row-time">{t?.duration ? fmt(t.duration) : ''}</span>
              <span className="mixsheet-row-tools">
                <button type="button" title="Nudge up" onClick={() => move(i, -1)}>↑</button>
                <button type="button" title="Nudge down" onClick={() => move(i, 1)}>↓</button>
                <button type="button" title="Off the tape" onClick={() => drop(i)}>×</button>
              </span>
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
                {tracks.length} songs · {fmt(totalMs)} of music. A tape holds {MAX_TAPE_SONGS} songs and plays start to finish as one gapless file. No undo — you can always tape over it.
              </p>
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
                Have Music Man deal the tape
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

        {stage === 'deck' && (
          <>
            <div className="activity-sheet-head">
              <input
                className="mixsheet-title-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="write on the label…"
              />
              {commentary && <p className="activity-sheet-sub">{commentary}</p>}
              {/* The C60/C90/C120 chips are gone: a tape's limit is 25
                  songs, not minutes, so there is no length to pick. */}
            </div>

            <div className="mixsheet-sides">
              {renderDeck()}
            </div>

            {floor.length > 0 && (
              <div className="mixsheet-floor">
                <span className="mixsheet-floor-label">Didn't make the tape:</span>{' '}
                {floor.map((t) => t.title).join(' · ')}
              </div>
            )}

            {existing && (
              <div className="mixsheet-tapeover-warning">
                Saving tapes over “{existing.title}” — the old arrangement is gone for good.
              </div>
            )}
            {error && <div className="mixsheet-error">{error}</div>}
            <div className="activity-sheet-actions">
              <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
              {!existing && (
                <button type="button" className="activity-btn activity-btn--ghost" onClick={() => { void build() }}>Re-deal</button>
              )}
              <button type="button" className="activity-btn activity-btn--go" onClick={() => { void save() }}>
                {existing ? 'Tape over it' : 'Dub the tape'}
              </button>
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
