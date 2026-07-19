/**
 * BlankTapeSheet — shrink-wrap off, label on, into the deck.
 * Pick the side length (30/45/60), scribble a title, Create → an empty
 * tape saves and loads straight into the DeckBar with REC ready. Then
 * it's just play + record — how mixtapes are made.
 */
import { useState } from 'react'
import { refreshMixtapes, setDeckState, pickInk } from '../mixtapes'
import type { Mixtape } from '../types'
import '../styles/activity-sheet.css'
import '../styles/mixtape.css'

interface Props {
  onClose: () => void
}

const TAPES: Array<{ len: 60 | 90 | 120; side: number }> = [
  { len: 60, side: 30 },
  { len: 90, side: 45 },
  { len: 120, side: 60 },
]

export default function BlankTapeSheet({ onClose }: Props) {
  const [tapeLength, setTapeLength] = useState<60 | 90 | 120>(90)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')

  const create = async () => {
    const id = `mix-${Date.now().toString(36)}`
    const tape: Mixtape = {
      id,
      title: title.trim() || `Tape · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      commentary: '',
      tapeLength,
      sideA: [],
      sideB: [],
      linerNotes: [],
      createdAt: new Date().toISOString(),
      inkColor: pickInk(id),
    }
    const r = await window.electronAPI.saveMixtape?.(tape)
    if (!r?.ok) {
      setError(r?.error || 'Could not wrap the tape.')
      return
    }
    await refreshMixtapes()
    // Straight into the deck, Side A, REC up — press it when you're ready.
    setDeckState({ mixtapeId: id, side: 'A', recArmed: false })
    onClose()
  }

  return (
    <div className="activity-sheet-overlay" role="dialog" aria-modal="true" aria-label="New blank tape">
      <div className="activity-sheet mixsheet mixsheet--blank">
        <div className="activity-sheet-head">
          <h2 className="activity-sheet-title">Blank tape</h2>
          <p className="activity-sheet-sub">
            It goes straight into the deck. Press REC, play music — whatever plays lands on the tape, in order, until the side runs out. TALK puts your voice down with the music.
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
          <span className="activity-q-label">Write on the label</span>
          <input className="activity-place" type="text" value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="summer '26 · for the car · side b is a secret…" />
        </div>
        {error && <div className="mixsheet-error">{error}</div>}
        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="activity-btn activity-btn--go" onClick={() => { void create() }}>
            Into the deck
          </button>
        </div>
      </div>
    </div>
  )
}
