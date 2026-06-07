import { useState, useEffect, useCallback } from 'react'
import { setNotice } from '../activity'
import '../styles/new-for-you.css'

interface RadarCandidate {
  artist: string
  title: string
  genre: string
  year: string
  why: string
  score: number
  reasons: string[]
}

// Module-level cache so the radar persists across view switches (same pattern
// as ListenToTheListView). Cleared only by an explicit Refresh.
let radarCache: RadarCandidate[] | null = null
let radarAtCache: number | null = null

export default function NewForYouView() {
  const [candidates, setCandidates] = useState<RadarCandidate[]>(radarCache ?? [])
  const [loading, setLoading] = useState(radarCache === null)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(radarAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())

  const fetchRadar = useCallback(async (force: boolean) => {
    setLoading(true); setError(null)
    try {
      const res = await window.electronAPI.getNewMusicRadar?.(force)
      if (res?.ok && res.candidates) {
        radarCache = res.candidates; radarAtCache = res.generatedAt ?? Date.now()
        setCandidates(res.candidates); setGeneratedAt(radarAtCache)
      } else {
        setError(res?.error || 'Discovery is unavailable right now.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Discovery failed.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (radarCache === null) void fetchRadar(false) }, [fetchRadar])

  const handleAdd = useCallback(async (c: RadarCandidate) => {
    const key = `${c.artist}|${c.title}`
    try {
      const res = await window.electronAPI.addRecommendation?.({ song: c.title, artist: c.artist, note: c.why })
      if (res?.ok) {
        setAdded((prev) => new Set(prev).add(key))
        setNotice(`Added “${c.title}” to your list.`, { kind: 'success' })
      } else {
        setNotice(res?.error || "Couldn't add to your list.", { kind: 'error' })
      }
    } catch {
      setNotice("Couldn't add to your list.", { kind: 'error' })
    }
  }, [])

  return (
    <div className="nfy">
      <div className="nfy-header">
        <div className="nfy-headtext">
          <h1 className="nfy-title">New for You</h1>
          <p className="nfy-sub">
            The Music Man, scouring this week’s releases for your taste
            {generatedAt ? ` · updated ${new Date(generatedAt).toLocaleDateString()}` : ''}
          </p>
        </div>
        <button className="nfy-refresh" disabled={loading} onClick={() => fetchRadar(true)}>
          {loading ? 'Digging…' : '↻ Refresh'}
        </button>
      </div>

      {loading && candidates.length === 0 && (
        <div className="nfy-loading">The Music Man is digging through the crates — pulling the best new releases for your taste…</div>
      )}
      {error && candidates.length === 0 && <div className="nfy-error">{error}</div>}
      {!loading && !error && candidates.length === 0 && (
        <div className="nfy-empty">Nothing yet — hit Refresh and give the Music Man a minute.</div>
      )}

      <div className="nfy-grid">
        {candidates.map((c) => {
          const key = `${c.artist}|${c.title}`
          const pct = Math.round(c.score * 100)
          const isAdded = added.has(key)
          return (
            <div key={key} className="nfy-card">
              <div className="nfy-card-head">
                <div className="nfy-card-title" title={c.title}>{c.title}</div>
                <div className="nfy-match" title={`${pct}% taste match`}>{pct}%</div>
              </div>
              <div className="nfy-artist">{c.artist}</div>
              <div className="nfy-meta">{[c.genre, c.year].filter(Boolean).join('  ·  ')}</div>
              {c.why && <p className="nfy-why">{c.why}</p>}
              {c.reasons?.length > 0 && <div className="nfy-reasons">{c.reasons.join(' · ')}</div>}
              <button className="nfy-add" disabled={isAdded} onClick={() => handleAdd(c)}>
                {isAdded ? '✓ On your list' : '+ Add to List'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
