import { useState, useCallback, useEffect } from 'react'
import { setUserAliases } from '../utils/artistAlias'
import { setNotice } from '../activity'
import type { ArtistGroupProposal } from '../types'
import '../styles/artist-grouping.css'

// Metadata hierarchy Phase 2 — review the AI's artist-grouping proposals and
// approve the persona merges. Nothing applies until the user clicks Apply: the
// approved tags get written to artist-aliases.json (raw tag → canonical) and
// pushed into the live alias store so Artists regroups instantly. Collaborations
// + standalone tags are shown read-only ("left separate") — they're never merged.
export default function ArtistGroupingModal({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<ArtistGroupProposal[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [showSeparate, setShowSeparate] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.classifyArtistGroups?.().then((r) => {
      if (cancelled) return
      if (r?.ok) {
        const ps = r.proposals || []
        setProposals(ps)
        setChecked(new Set(ps.filter((p) => p.type === 'persona' && p.canonical).map((p) => p.tag)))
      } else {
        setError(r?.error || 'Classification failed.')
      }
      setLoading(false)
    }).catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Classification failed.'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  const personas = proposals.filter((p) => p.type === 'persona' && p.canonical)
  const separate = proposals.filter((p) => p.type !== 'persona' || !p.canonical)

  const toggle = (tag: string) => setChecked((prev) => {
    const n = new Set(prev)
    if (n.has(tag)) n.delete(tag); else n.add(tag)
    return n
  })

  const apply = useCallback(async () => {
    setApplying(true)
    const additions: Record<string, string> = {}
    for (const p of personas) if (checked.has(p.tag) && p.canonical) additions[p.tag] = p.canonical
    try {
      // Merge into the RAW persisted map (keys are display tags), then re-push.
      const loaded = await window.electronAPI.loadArtistAliases?.()
      const base = (loaded?.ok ? loaded.aliases : {}) || {}
      const merged = { ...base, ...additions }
      const res = await window.electronAPI.saveArtistAliases?.(merged)
      if (res?.ok) {
        setUserAliases(merged)  // regroup instantly
        const n = Object.keys(additions).length
        setNotice(`Grouped ${n} artist tag${n === 1 ? '' : 's'}.`, { kind: 'success' })
        onClose()
        return
      }
      setNotice(res?.error || "Couldn't save groupings.", { kind: 'error' })
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't save groupings.", { kind: 'error' })
    }
    setApplying(false)
  }, [personas, checked, onClose])

  return (
    <div className="agm-overlay" onClick={onClose}>
      <div className="agm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="agm-head">
          <div>
            <h2 className="agm-title">Group artists</h2>
            <p className="agm-sub">The Music Man classified your artist tags. Approve the merges you want — nothing changes until you apply.</p>
          </div>
          <button className="agm-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {loading && (
          <div className="agm-loading">The Music Man is sorting your artists by relationship…</div>
        )}
        {error && !loading && <div className="agm-error">{error}</div>}

        {!loading && !error && (
          <>
            {personas.length === 0 ? (
              <div className="agm-empty">No new merges suggested — your artists already read cleanly. 🎉</div>
            ) : (
              <div className="agm-section">
                <div className="agm-section-head">
                  <span>Suggested merges</span>
                  <span className="agm-count">{checked.size}/{personas.length} approved</span>
                </div>
                <div className="agm-list">
                  {personas.map((p) => {
                    const on = checked.has(p.tag)
                    return (
                      <label key={p.tag} className={`agm-row ${on ? 'agm-row--on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggle(p.tag)} />
                        <span className="agm-row-body">
                          <span className="agm-merge">
                            <span className="agm-tag">{p.tag}</span>
                            <span className="agm-arrow">→</span>
                            <span className="agm-canon">{p.canonical}</span>
                          </span>
                          {p.why && <span className="agm-why">{p.why}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            {separate.length > 0 && (
              <div className="agm-section agm-section--separate">
                <button className="agm-section-head agm-toggle" onClick={() => setShowSeparate((v) => !v)}>
                  <span>{separate.length} left separate (collaborations + standalone bands)</span>
                  <span>{showSeparate ? '▾' : '▸'}</span>
                </button>
                {showSeparate && (
                  <div className="agm-list">
                    {separate.map((p) => (
                      <div key={p.tag} className="agm-row agm-row--readonly">
                        <span className="agm-row-body">
                          <span className="agm-merge">
                            <span className="agm-tag">{p.tag}</span>
                            <span className={`agm-badge agm-badge--${p.type}`}>{p.type === 'collaboration' ? 'collab' : 'standalone'}</span>
                          </span>
                          {p.why && <span className="agm-why">{p.why}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="agm-foot">
          <button className="agm-btn agm-btn--ghost" onClick={onClose} disabled={applying}>Cancel</button>
          <button className="agm-btn agm-btn--primary" onClick={apply} disabled={loading || applying || checked.size === 0}>
            {applying ? 'Applying…' : `Apply ${checked.size} grouping${checked.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
