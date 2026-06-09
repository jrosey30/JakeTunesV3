import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'
import { setNotice } from '../activity'
import { togglePreview, subscribePreview, getPreviewSnapshot, stopPreview } from '../previewPlayer'
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

// Module-level cache so the radar (and its iTunes enrichment) persist across
// view switches. Cleared only by an explicit Refresh.
let radarCache: RadarCandidate[] | null = null
let radarAtCache: number | null = null
const enrichCache: Record<string, { art?: string; preview?: string }> = {}

export default function NewForYouView() {
  const [candidates, setCandidates] = useState<RadarCandidate[]>(radarCache ?? [])
  const [loading, setLoading] = useState(radarCache === null)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(radarAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [enriched, setEnriched] = useState<Record<string, { art?: string; preview?: string }>>({ ...enrichCache })
  const previewState = useSyncExternalStore(subscribePreview, getPreviewSnapshot)

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

  // Lazily enrich each card with iTunes cover art + a 30s preview URL.
  // Fires in parallel; cards fill in as results land. Cached across remounts.
  useEffect(() => {
    if (candidates.length === 0) return
    let cancelled = false
    for (const c of candidates) {
      const key = `${c.artist}|${c.title}`
      if (enrichCache[key]) continue
      // Artist-verified art: main accepts a cover ONLY from an iTunes row whose
      // artist matches this candidate. No match → leave un-enriched so the card
      // shows its ♪ placeholder instead of a confidently-wrong cover.
      window.electronAPI.lookupRecoArtwork?.({ artist: c.artist, title: c.title }).then((r) => {
        if (cancelled || !r?.artworkUrl) return
        const entry = { art: r.artworkUrl, preview: r.previewUrl }
        enrichCache[key] = entry
        setEnriched((prev) => ({ ...prev, [key]: entry }))
      }).catch(() => { /* leave un-enriched */ })
    }
    return () => { cancelled = true }
  }, [candidates])

  // Mark candidates already on the user's list as "added" (button reads "On
  // your list", can't re-add) — covers a stale radar cache served from a prior
  // day/session where the in-session `added` set is empty. The radar IPC also
  // filters fresh generations against the list; this is the cache-reuse backstop.
  useEffect(() => {
    if (candidates.length === 0) return
    let cancelled = false
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    window.electronAPI.loadRecommendations?.().then((res) => {
      if (cancelled || !res?.ok) return
      const onList = new Set<string>()
      for (const r of res.recommendations || []) {
        const a = norm(r.artist || r.matchedArtist || '')
        const t = norm(r.song || r.matchedTitle || '')
        if (a && t) onList.add(`${a}|${t}`)
      }
      setAdded((prev) => {
        const next = new Set(prev)
        for (const c of candidates) {
          if (onList.has(`${norm(c.artist)}|${norm(c.title)}`)) next.add(`${c.artist}|${c.title}`)
        }
        return next
      })
    }).catch(() => { /* list unavailable — leave as-is */ })
    return () => { cancelled = true }
  }, [candidates])

  // Stop any preview when leaving the view.
  useEffect(() => () => stopPreview(), [])

  const handleAdd = useCallback(async (c: RadarCandidate) => {
    const key = `${c.artist}|${c.title}`
    try {
      const res = await window.electronAPI.addRecommendation?.({ song: c.title, artist: c.artist, note: c.why, source: 'radar' })
      if (res?.ok) {
        setAdded((prev) => new Set(prev).add(key))
        setNotice(res.deduped ? `“${c.title}” is already on your list.` : `Added “${c.title}” to your list.`, { kind: 'success' })
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
          const art = enriched[key]?.art
          const previewUrl = enriched[key]?.preview
          const isPlaying = previewState.playingId === key
          return (
            <div key={key} className="nfy-card">
              <div className="nfy-cover">
                {art
                  ? <img src={art} alt={c.title} loading="lazy" />
                  : <div className="nfy-cover-ph">♫</div>}
                <div className="nfy-match" title={`${pct}% taste match`}>{pct}%</div>
                {previewUrl && (
                  <button
                    className={`nfy-preview ${isPlaying ? 'nfy-preview--on' : ''}`}
                    onClick={() => togglePreview(key, previewUrl, c.title, c.artist)}
                    title={isPlaying ? 'Stop preview' : 'Play 30s preview'}
                    aria-label={isPlaying ? 'Stop preview' : 'Play preview'}
                  >{isPlaying ? '⏹' : '▶'}</button>
                )}
              </div>
              <div className="nfy-card-body">
                <div className="nfy-card-title" title={c.title}>{c.title}</div>
                <div className="nfy-artist">{c.artist}</div>
                <div className="nfy-meta">{[c.genre, c.year].filter(Boolean).join('  ·  ')}</div>
                {c.why && <p className="nfy-why">{c.why}</p>}
                <button className="nfy-add" disabled={isAdded} onClick={() => handleAdd(c)}>
                  {isAdded ? '✓ On your list' : '+ Add to List'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
