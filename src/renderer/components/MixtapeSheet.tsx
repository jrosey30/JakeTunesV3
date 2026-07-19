/**
 * MixtapeSheet — the tape deck.
 *
 * Setup: pick the tape by SIDE length (30/30, 45/45, 60/60), dedication,
 * note, record the voice intro. Music Man deals the first cut of the
 * tape — then you land on THE DECK and mix it like it's 1985:
 *   ↑ ↓  nudge a song up/down the side
 *   ⇄    bump it to the other side
 *   ×    off the tape (back on the floor)
 *   floor + shelf: put any song back on, or pull anything from the
 *   whole library, straight onto a side
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
import { fitSide } from '../../common/tape-physics'
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

const TAPES: Array<{ len: 60 | 90 | 120; side: number }> = [
  { len: 60, side: 30 },
  { len: 90, side: 45 },
  { len: 120, side: 60 },
]

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function MixtapeSheet({ tracks, onClose, existing }: Props) {
  const { state: lib, dispatch } = useLibrary()
  const [stage, setStage] = useState<Stage>(existing ? 'deck' : 'setup')
  const [tapeLength, setTapeLength] = useState<60 | 90 | 120>(existing?.tapeLength ?? 90)
  const [dedication, setDedication] = useState(existing?.dedication ?? '')
  const [note, setNote] = useState('')
  const [introPath, setIntroPath] = useState<string | null>(existing?.introPath ?? null)
  const [error, setError] = useState('')
  const [title, setTitle] = useState(existing?.title ?? '')
  const [commentary, setCommentary] = useState(existing?.commentary ?? '')
  const [linerNotes, setLinerNotes] = useState<Array<{ id: number; note: string }>>(existing?.linerNotes ?? [])
  // The deck: full placed order per side — may run past the end of the
  // tape; physics decides what actually records.
  const [deckA, setDeckA] = useState<number[]>(existing?.sideA ?? [])
  const [deckB, setDeckB] = useState<number[]>(existing?.sideB ?? [])
  const [shelfQuery, setShelfQuery] = useState('')

  const libById = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])
  const dur = (id: number) => libById.get(id)?.duration || undefined
  const sideBudgetMs = (tapeLength / 2) * 60_000

  const fitA = useMemo(() => fitSide(deckA, dur, sideBudgetMs), [deckA, sideBudgetMs, libById])
  const fitB = useMemo(() => fitSide(deckB, dur, sideBudgetMs), [deckB, sideBudgetMs, libById])

  const placed = useMemo(() => new Set([...deckA, ...deckB]), [deckA, deckB])
  // The floor: songs brought to the session but not on either side.
  const floor = useMemo(() => tracks.filter((t) => !placed.has(t.id)), [tracks, placed])

  const shelfResults = useMemo(() => {
    const q = shelfQuery.trim().toLowerCase()
    if (q.length < 2) return []
    const out: Track[] = []
    for (const t of lib.tracks) {
      if (placed.has(t.id)) continue
      if (`${t.title || ''} ${t.artist || ''}`.toLowerCase().includes(q)) {
        out.push(t)
        if (out.length >= 6) break
      }
    }
    return out
  }, [shelfQuery, lib.tracks, placed])

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
      setTitle(r.title || 'Mixtape')
      setCommentary(r.commentary || '')
      setLinerNotes(r.linerNotes || [])
      setDeckA(r.sideA)
      setDeckB(r.sideB || [])
      setStage('deck')
    } catch (err) {
      setError(String(err))
      setStage('setup')
    }
  }

  const save = async () => {
    if (fitA.ids.length + fitB.ids.length < 1) {
      setError('The tape is blank — put at least one song on a side.')
      return
    }
    const id = existing?.id ?? `mix-${Date.now().toString(36)}`
    const onTape = new Set([...fitA.ids, ...fitB.ids])
    const tape: Mixtape = {
      id,
      title: title.trim() || 'Mixtape',
      commentary,
      dedication: dedication.trim() || undefined,
      tapeLength,
      sideA: fitA.ids,
      sideB: fitB.ids,
      sideACutMs: fitA.cutMs,
      sideBCutMs: fitB.cutMs,
      linerNotes: linerNotes.filter((n) => onTape.has(n.id)),
      introPath: introPath || undefined,
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
  const move = (side: 'A' | 'B', idx: number, delta: number) => {
    const set = side === 'A' ? setDeckA : setDeckB
    set((cur) => {
      const next = [...cur]
      const j = idx + delta
      if (j < 0 || j >= next.length) return cur
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }
  const bump = (side: 'A' | 'B', idx: number) => {
    if (side === 'A') {
      const id = deckA[idx]
      if (id == null) return
      setDeckA(deckA.filter((_, i) => i !== idx))
      setDeckB([...deckB, id])
    } else {
      const id = deckB[idx]
      if (id == null) return
      setDeckB(deckB.filter((_, i) => i !== idx))
      setDeckA([...deckA, id])
    }
  }
  const drop = (side: 'A' | 'B', idx: number) => {
    const set = side === 'A' ? setDeckA : setDeckB
    set((cur) => cur.filter((_, i) => i !== idx))
  }
  const place = (id: number, side: 'A' | 'B') => {
    if (placed.has(id)) return
    if (side === 'A') setDeckA((cur) => [...cur, id])
    else setDeckB((cur) => [...cur, id])
    setShelfQuery('')
  }

  const renderDeckSide = (label: 'A' | 'B', ids: number[], fit: ReturnType<typeof fitSide>) => {
    const leftMs = sideBudgetMs - fit.usedMs
    const cutId = fit.cutMs !== undefined ? fit.ids[fit.ids.length - 1] : null
    const dead = new Set(fit.overflowIds)
    return (
      <div className="mixsheet-side">
        <div className="mixsheet-side-head">
          SIDE {label}
          <span className="mixsheet-counter">
            {fit.cutMs !== undefined || leftMs <= 0 ? 'tape full' : `${fmt(fit.usedMs)} · ${fmt(leftMs)} left`}
          </span>
        </div>
        {ids.map((tid, i) => {
          const t = libById.get(tid)
          const isCut = tid === cutId
          const isDead = dead.has(tid)
          return (
            <div key={tid} className={`mixsheet-row${isDead ? ' mixsheet-row--dead' : ''}`}>
              <span className="mixsheet-row-num">{i + 1}.</span>
              <span className="mixsheet-row-title">
                {t?.title || `#${tid}`}
                {isCut ? <em className="mixsheet-cut-note"> — cuts off at {fmt(fit.cutMs!)}</em> : null}
                {isDead ? <em className="mixsheet-cut-note"> — didn't record</em> : null}
              </span>
              <span className="mixsheet-row-artist">{t?.artist || ''}</span>
              <span className="mixsheet-row-tools">
                <button type="button" title="Nudge up" onClick={() => move(label, i, -1)}>↑</button>
                <button type="button" title="Nudge down" onClick={() => move(label, i, 1)}>↓</button>
                <button type="button" title={`Bump to Side ${label === 'A' ? 'B' : 'A'}`} onClick={() => bump(label, i)}>⇄</button>
                <button type="button" title="Off the tape" onClick={() => drop(label, i)}>×</button>
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
                {tracks.length} songs · {fmt(totalMs)} of music. TRUE tape time — when a side runs out, the song cuts off right there, like 1985. No undo. You can always tape over it.
              </p>
            </div>
            <div className="activity-q">
              <span className="activity-q-label">The tape (minutes a side)</span>
              <div className="activity-chips">
                {TAPES.map(({ len, side }) => (
                  <button key={len} type="button"
                    className={`activity-chip${tapeLength === len ? ' is-on' : ''}`}
                    onClick={() => setTapeLength(len)}
                  >{side} / {side} <small>(C{len})</small></button>
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
              <div className="activity-chips mixsheet-deck-tapes">
                {TAPES.map(({ len, side }) => (
                  <button key={len} type="button"
                    className={`activity-chip${tapeLength === len ? ' is-on' : ''}`}
                    onClick={() => setTapeLength(len)}
                    title="Dub to a different length tape — the counters recompute"
                  >{side} / {side}</button>
                ))}
              </div>
            </div>

            <div className="mixsheet-sides">
              {renderDeckSide('A', deckA, fitA)}
              {renderDeckSide('B', deckB, fitB)}
            </div>

            {floor.length > 0 && (
              <div className="mixsheet-floor">
                <span className="mixsheet-floor-label">On the floor:</span>
                {floor.map((t) => (
                  <span key={t.id} className="mixsheet-floor-chip">
                    {t.title}
                    <button type="button" title="Onto Side A" onClick={() => place(t.id, 'A')}>+A</button>
                    <button type="button" title="Onto Side B" onClick={() => place(t.id, 'B')}>+B</button>
                  </span>
                ))}
              </div>
            )}

            <div className="mixsheet-shelf">
              <input className="activity-place" type="text" value={shelfQuery}
                onChange={(e) => setShelfQuery(e.target.value)}
                placeholder="Pull anything from the shelf — search your whole library…" />
              {shelfResults.length > 0 && (
                <div className="mixsheet-shelf-results">
                  {shelfResults.map((t) => (
                    <div key={t.id} className="mixsheet-row">
                      <span className="mixsheet-row-title">{t.title}</span>
                      <span className="mixsheet-row-artist">{t.artist}</span>
                      <span className="mixsheet-row-tools">
                        <button type="button" onClick={() => place(t.id, 'A')}>+A</button>
                        <button type="button" onClick={() => place(t.id, 'B')}>+B</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
