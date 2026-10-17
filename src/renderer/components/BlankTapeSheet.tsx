/**
 * BlankTapeSheet — shrink-wrap off, label on, into the deck.
 * Pick the side length (30/45/60), scribble a title, Create → an empty
 * tape saves and loads straight into the DeckBar with REC ready. Then
 * it's just play + record — how mixtapes are made.
 */
import { useEffect, useRef, useState } from 'react'
import { refreshMixtapes, setDeckState, pickInk } from '../mixtapes'
import type { Mixtape } from '../types'
import '../styles/activity-sheet.css'
import '../styles/mixtape.css'

interface Props {
  onClose: () => void
}


export default function BlankTapeSheet({ onClose }: Props) {
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  // Enter auto-repeats when held — one tape per press, not one per repeat.
  const creatingRef = useRef(false)

  // Esc backs out from anywhere in the sheet (capture, like ConfirmDialog,
  // so nothing behind the sheet also acts on it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const create = async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    try { await wrapTape() } finally { creatingRef.current = false }
  }

  const wrapTape = async () => {
    const id = `mix-${Date.now().toString(36)}`
    const tape: Mixtape = {
      id,
      title: title.trim() || `Tape · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      commentary: '',
      tracks: [],
      // Legacy shape, still on the record so old tapes keep reading.
      tapeLength: 90,
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
            It goes straight into the deck. Press REC, play music — whatever plays lands on the tape, in order, until the tape is full. TALK puts your voice down with the music.
          </p>
        </div>
        <div className="activity-q">
          <span className="activity-q-label">Write on the label</span>
          <input className="activity-place" type="text" value={title} autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void create() } }}
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
