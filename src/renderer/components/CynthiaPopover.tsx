import { useCallback, useEffect, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { CynthiaScope, CynthiaFix, CynthiaMissingTrack } from '../types'
import '../styles/cynthia.css'

// Chat-style popover. Cynthia is two models stacked:
//   - Haiku 4.5 fronts the conversation, terse and direct.
//   - Haiku calls a deep_investigate tool that fires Sonnet 4.6 + the
//     MusicBrainz/web_search toolkit to produce structured fixes.
// Each Cynthia turn can carry an attached investigation (fixes +
// missingTracks). The user picks which fixes to apply per-turn and keeps
// the conversation going.

interface Props {
  x: number
  y: number
  scope: CynthiaScope
  onClose: () => void
}

const POPOVER_WIDTH = 420
const POPOVER_MAX_HEIGHT = 560

interface ChatTurn {
  role: 'user' | 'cynthia'
  text: string
  investigation?: {
    summary: string
    fixes: CynthiaFix[]
    missingTracks: CynthiaMissingTrack[]
    rationale: string
  }
  // Per-turn selection state for fixes. `applied` flips when the user
  // hits Apply on this turn's card.
  selectedIdx?: Set<number>
  applied?: boolean
  pending?: boolean
}

// Cynthia is allowed to write only these fields. Anything else gets dropped
// at apply-time. See the long comment in handleApplyTurn for context.
const ALLOWED_FIELDS = new Set([
  'trackNumber', 'title', 'artist', 'album', 'albumArtist',
  'year', 'genre', 'discNumber', 'trackCount', 'discCount',
])
const FIELD_ALIASES: Record<string, string> = {
  track_number: 'trackNumber', tracknumber: 'trackNumber', track_no: 'trackNumber', trackno: 'trackNumber',
  album_artist: 'albumArtist', albumartist: 'albumArtist',
  disc_number: 'discNumber', discnumber: 'discNumber', disc_no: 'discNumber', discno: 'discNumber',
  track_count: 'trackCount', trackcount: 'trackCount', total_tracks: 'trackCount',
  disc_count: 'discCount', disccount: 'discCount', total_discs: 'discCount',
}
function normalizeField(raw: string): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase().replace(/[\s-]+/g, '_')
  if (ALLOWED_FIELDS.has(raw)) return raw
  const alias = FIELD_ALIASES[lower]
  if (alias) return alias
  if (ALLOWED_FIELDS.has(lower)) return lower
  return null
}

export default function CynthiaPopover({ x, y, scope, onClose }: Props) {
  const { dispatch } = useLibrary()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  busyRef.current = busy

  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const left = Math.min(Math.max(8, x), window.innerWidth - POPOVER_WIDTH - 8)
    const top = Math.min(Math.max(8, y), window.innerHeight - POPOVER_MAX_HEIGHT - 8)
    return { left, top }
  })

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const overflowX = (rect.left + rect.width) - (window.innerWidth - 8)
    const overflowY = (rect.top + rect.height) - (window.innerHeight - 8)
    if (overflowX > 0 || overflowY > 0) {
      setPos(p => ({
        left: overflowX > 0 ? Math.max(8, p.left - overflowX) : p.left,
        top: overflowY > 0 ? Math.max(8, p.top - overflowY) : p.top,
      }))
    }
  }, [turns.length])

  // Auto-scroll thread to bottom as new turns arrive.
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [turns])

  // Outside-click & Escape close — but never while a request is in flight.
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (busyRef.current) return
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose()
    }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const sendMessage = useCallback(async (userText: string) => {
    const trimmed = userText.trim()
    if (!trimmed || busyRef.current) return

    // Optimistic: append the user turn + a pending Cynthia turn.
    const nextTurns: ChatTurn[] = [
      ...turns,
      { role: 'user', text: trimmed },
      { role: 'cynthia', text: '', pending: true },
    ]
    setTurns(nextTurns)
    setDraft('')
    setBusy(true)

    // Build the full message history for the API. Each cynthia turn
    // contributes its visible text; pending turns get skipped.
    const apiMessages: { role: 'user' | 'assistant'; content: string }[] = []
    for (const t of nextTurns) {
      if (t.pending) continue
      if (t.role === 'user') apiMessages.push({ role: 'user', content: t.text })
      else if (t.role === 'cynthia') apiMessages.push({ role: 'assistant', content: t.text })
    }
    // Append the new user message.
    apiMessages.push({ role: 'user', content: trimmed })

    try {
      const r = await window.electronAPI.cynthiaChat({ scope, messages: apiMessages })
      if (!r.ok) {
        setTurns(prev => prev.map((t, i) =>
          i === prev.length - 1 ? { ...t, pending: false, text: `(${r.error || 'Cynthia hit a wall.'})` } : t
        ))
        return
      }

      const inv = r.investigation
      // Filter no-op fixes (oldValue === newValue) before showing.
      const cleanedFixes: CynthiaFix[] = inv ? (inv.fixes || []).filter(f => {
        const a = String(f.oldValue ?? '').trim()
        const b = String(f.newValue ?? '').trim()
        return a !== b
      }) : []

      setTurns(prev => prev.map((t, i) => {
        if (i !== prev.length - 1) return t
        return {
          role: 'cynthia',
          text: r.text || (inv?.summary || ''),
          investigation: inv ? {
            summary: inv.summary,
            fixes: cleanedFixes,
            missingTracks: inv.missingTracks || [],
            rationale: inv.rationale,
          } : undefined,
          selectedIdx: cleanedFixes.length > 0 ? new Set(cleanedFixes.map((_, i) => i)) : undefined,
          pending: false,
        }
      }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setTurns(prev => prev.map((t, i) =>
        i === prev.length - 1 ? { ...t, pending: false, text: `(${msg})` } : t
      ))
    } finally {
      setBusy(false)
      // Refocus input so the user can keep typing without clicking.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [turns, scope])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(draft)
    }
  }, [draft, sendMessage])

  const toggleFixSelection = useCallback((turnIdx: number, fixIdx: number) => {
    setTurns(prev => prev.map((t, i) => {
      if (i !== turnIdx || !t.selectedIdx) return t
      const next = new Set(t.selectedIdx)
      if (next.has(fixIdx)) next.delete(fixIdx)
      else next.add(fixIdx)
      return { ...t, selectedIdx: next }
    }))
  }, [])

  const setSelectionAll = useCallback((turnIdx: number, all: boolean) => {
    setTurns(prev => prev.map((t, i) => {
      if (i !== turnIdx || !t.investigation) return t
      const next = all ? new Set(t.investigation.fixes.map((_, j) => j)) : new Set<number>()
      return { ...t, selectedIdx: next }
    }))
  }, [])

  const applyTurn = useCallback(async (turnIdx: number) => {
    const t = turns[turnIdx]
    if (!t || !t.investigation || !t.selectedIdx) return
    // Same persistence pattern as before:
    //   - field name is normalized against an allow-list
    //   - oldValue/newValue carries to the override file alongside a
    //     "title|artist|duration" fingerprint so App.tsx's override
    //     loader keeps the entry across restarts
    const fixes = t.investigation.fixes.filter((_, i) => t.selectedIdx!.has(i))
    if (fixes.length > 0) {
      const normalized: { id: number; field: string; value: string; fingerprint: string }[] = []
      for (const f of fixes) {
        const field = normalizeField(f.field)
        if (!field) continue
        const tr = scope.tracks.find(x => x.id === f.trackId)
        if (!tr) continue
        const fp = `${(tr.title || '').toLowerCase().trim()}|${(tr.artist || '').toLowerCase().trim()}|${tr.duration || 0}`
        normalized.push({ id: f.trackId, field, value: String(f.newValue ?? ''), fingerprint: fp })
      }
      if (normalized.length > 0) {
        dispatch({
          type: 'UPDATE_TRACKS',
          updates: normalized.map(u => ({ id: u.id, field: u.field, value: u.value })),
        })
        for (const u of normalized) {
          try { await window.electronAPI.saveMetadataOverride(u.id, u.field, u.value, u.fingerprint) }
          catch { /* per-field failure is non-fatal */ }
        }
      }
    }
    // Brief Music Man on what just happened.
    const rationale = t.investigation.rationale || t.investigation.summary || ''
    if (rationale) {
      try { await window.electronAPI.cynthiaReportToMusicMan({ rationale, summary: t.investigation.summary }) }
      catch { /* non-fatal */ }
    }
    setTurns(prev => prev.map((tt, i) => i === turnIdx ? { ...tt, applied: true } : tt))
  }, [turns, dispatch, scope])

  const scopeLabel = (() => {
    if (scope.type === 'album') return `the album "${scope.label}"`
    if (scope.type === 'artist') return `everything by ${scope.label}`
    if (scope.type === 'playlist') return `the playlist "${scope.label}"`
    if (scope.tracks.length === 1) return `"${scope.tracks[0].title}"`
    return `${scope.tracks.length} tracks`
  })()

  return (
    <div
      ref={containerRef}
      className="cynthia-popover"
      style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="cynthia-header">
        <div className="cynthia-avatar">C</div>
        <div className="cynthia-header-text">
          <div className="cynthia-name">Cynthia</div>
          <div className="cynthia-role">archivist · {scopeLabel}</div>
        </div>
        {!busy && (
          <button className="cynthia-close" onClick={onClose} title="Close">×</button>
        )}
      </div>

      <div className="cynthia-thread" ref={threadRef}>
        {turns.length === 0 && (
          <div className="cynthia-empty-thread">
            <div className="cynthia-empty-thread-text">Hey. What's up with this one?</div>
            <div className="cynthia-empty-thread-sub">Try: <em>"check the disc count"</em>, <em>"find missing tracks"</em>, <em>"are the track numbers right?"</em></div>
          </div>
        )}
        {turns.map((t, ti) => t.role === 'user' ? (
          <div key={ti} className="cynthia-msg cynthia-msg--user">
            <div className="cynthia-msg-bubble cynthia-msg-bubble--user">{t.text}</div>
          </div>
        ) : (
          <div key={ti} className="cynthia-msg cynthia-msg--cynthia">
            {t.pending ? (
              <div className="cynthia-msg-bubble cynthia-msg-bubble--cynthia cynthia-msg-bubble--pending">
                <span className="cynthia-typing"><span /><span /><span /></span>
              </div>
            ) : (
              <>
                {t.text && (
                  <div className="cynthia-msg-bubble cynthia-msg-bubble--cynthia">{t.text}</div>
                )}
                {t.investigation && (
                  <InvestigationCard
                    turn={t}
                    turnIdx={ti}
                    scope={scope}
                    onToggleFix={toggleFixSelection}
                    onSelectAll={() => setSelectionAll(ti, true)}
                    onSelectNone={() => setSelectionAll(ti, false)}
                    onApply={() => applyTurn(ti)}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div className="cynthia-input-row">
        <textarea
          ref={inputRef}
          className="cynthia-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={turns.length === 0 ? "What needs sorting?" : "Reply…"}
          rows={1}
          disabled={busy}
        />
        <button
          className="cynthia-btn cynthia-btn--primary cynthia-send"
          onClick={() => sendMessage(draft)}
          disabled={!draft.trim() || busy}
          title="Send (Enter)"
        >
          ↑
        </button>
      </div>
    </div>
  )
}

function InvestigationCard({
  turn, turnIdx, scope, onToggleFix, onSelectAll, onSelectNone, onApply,
}: {
  turn: ChatTurn
  turnIdx: number
  scope: CynthiaScope
  onToggleFix: (turnIdx: number, fixIdx: number) => void
  onSelectAll: () => void
  onSelectNone: () => void
  onApply: () => void
}) {
  if (!turn.investigation) return null
  const { fixes, missingTracks } = turn.investigation
  const selected = turn.selectedIdx ?? new Set<number>()
  return (
    <div className={`cynthia-card ${turn.applied ? 'cynthia-card--applied' : ''}`}>
      {fixes.length > 0 && (
        <div className="cynthia-section">
          <div className="cynthia-section-title">
            Here's what I'd change <span className="cynthia-count">{selected.size}/{fixes.length}</span>
            {fixes.length > 1 && !turn.applied && (
              <span className="cynthia-select-actions">
                <button type="button" className="cynthia-select-link" onClick={onSelectAll}>all</button>
                <span className="cynthia-select-sep">·</span>
                <button type="button" className="cynthia-select-link" onClick={onSelectNone}>none</button>
              </span>
            )}
          </div>
          <div className="cynthia-list">
            {fixes.map((f: CynthiaFix, i: number) => {
              const checked = selected.has(i)
              return (
                <div
                  key={i}
                  className={`cynthia-fix-row ${checked ? '' : 'cynthia-fix-row--unchecked'} ${turn.applied ? 'cynthia-fix-row--locked' : ''}`}
                  onClick={() => !turn.applied && onToggleFix(turnIdx, i)}
                  role="checkbox"
                  aria-checked={checked}
                  tabIndex={turn.applied ? -1 : 0}
                  onKeyDown={(e) => {
                    if (turn.applied) return
                    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggleFix(turnIdx, i) }
                  }}
                >
                  <div className="cynthia-fix-track">
                    <span className={`cynthia-fix-checkbox ${checked ? 'cynthia-fix-checkbox--on' : ''}`}>
                      {checked ? '✓' : ''}
                    </span>
                    <span className="cynthia-fix-title">{titleForTrackId(f.trackId, scope) || `Track #${f.trackId}`}</span>
                    <span className="cynthia-fix-field">{f.field}</span>
                  </div>
                  <div className="cynthia-fix-change">
                    <span className="cynthia-fix-old">{formatVal(f.oldValue)}</span>
                    <span className="cynthia-fix-arrow">→</span>
                    <span className="cynthia-fix-new">{formatVal(f.newValue)}</span>
                  </div>
                  {f.reason && <div className="cynthia-fix-reason">{f.reason}</div>}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {missingTracks.length > 0 && (
        <div className="cynthia-section">
          <div className="cynthia-section-title">Missing <span className="cynthia-count">{missingTracks.length}</span></div>
          <div className="cynthia-list">
            {missingTracks.map((m: CynthiaMissingTrack, i: number) => (
              <div key={i} className="cynthia-missing-row">
                <span className="cynthia-missing-track">{m.discNumber && m.discNumber > 1 ? `D${m.discNumber} · ` : ''}#{m.trackNumber}</span>
                <span className="cynthia-missing-title">{m.title}</span>
                {m.duration ? <span className="cynthia-missing-dur">{formatDuration(m.duration)}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
      {fixes.length > 0 && !turn.applied && (
        <div className="cynthia-card-footer">
          <button
            className="cynthia-btn cynthia-btn--primary"
            onClick={onApply}
            disabled={selected.size === 0}
          >
            Apply {selected.size} fix{selected.size !== 1 ? 'es' : ''}
          </button>
        </div>
      )}
      {turn.applied && (
        <div className="cynthia-applied-pill">Applied · ✓</div>
      )}
    </div>
  )
}

function titleForTrackId(id: number, scope: CynthiaScope): string {
  const t = scope.tracks.find(x => x.id === id)
  return t?.title || ''
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}
