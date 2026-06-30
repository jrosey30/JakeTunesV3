import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { setNotice } from '../activity'
import { togglePreview, subscribePreview, getPreviewSnapshot, stopPreview } from '../previewPlayer'
import { formatAppDate } from '../utils/formatDate'
import {
  canDownloadReco,
  getLtlDownloadStatus,
  isLtlDownloadBusy,
  queueRecoDownload,
  subscribeLtlDownload,
  getLtlDownloadSnapshot,
} from '../listen-to-the-list/ltlDownload'
import type { Recommendation } from '../types'
import '../styles/new-for-you.css'

interface RadarCandidate {
  artist: string
  title: string
  genre: string
  year: string
  why: string
  anchor?: string
  score: number
  reasons: string[]
}

interface TasteAnchor {
  artist: string
  plays: number
  tracks: number
  primaryGenre: string
}

interface RediscoveryPick {
  artist: string
  album: string
  genre: string
  ownedTracks: number
  plays: number
  rating: number
  addedAt: string
  reason: string
}

interface TasteFingerprint {
  summary: string
  topGenres: Array<{ genre: string; weight: number }>
  topArtists?: Array<{ artist: string; plays: number; tracks: number }>
  spines: Array<{ name: string; weight: number }>
  peakDecade: number | null
}

let radarCache: RadarCandidate[] | null = null
let radarAtCache: number | null = null
let radarSummaryCache: string | null = null
let anchorsCache: TasteAnchor[] | null = null
let rediscoveryCache: RediscoveryPick[] | null = null
let rediscoveryAtCache: number | null = null
let tasteCache: TasteFingerprint | null = null
const enrichCache: Record<string, { art?: string; preview?: string }> = {}

function radarKey(c: { artist: string; title: string }): string {
  return `${c.artist}|${c.title}`
}

function asReco(c: RadarCandidate): Recommendation {
  return {
    id: radarKey(c),
    song: c.title,
    artist: c.artist,
    album: c.title,
    note: c.why,
    createdAt: new Date().toISOString(),
    source: 'radar',
  }
}

export default function NewForYouView() {
  const [candidates, setCandidates] = useState<RadarCandidate[]>(radarCache ?? [])
  const [rediscovery, setRediscovery] = useState<RediscoveryPick[]>(rediscoveryCache ?? [])
  const [taste, setTaste] = useState<TasteFingerprint | null>(tasteCache)
  const [anchors, setAnchors] = useState<TasteAnchor[]>(anchorsCache ?? [])
  const [radarLoading, setRadarLoading] = useState(radarCache === null)
  const [rediscoLoading, setRediscoLoading] = useState(rediscoveryCache === null)
  const [radarError, setRadarError] = useState<string | null>(null)
  const [rediscoError, setRediscoError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(radarAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [enriched, setEnriched] = useState<Record<string, { art?: string; preview?: string }>>({ ...enrichCache })
  const previewState = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)

  const fetchTaste = useCallback(async () => {
    try {
      const r = await window.electronAPI.getTasteFingerprint?.()
      if (r?.ok && r.fingerprint) {
        tasteCache = r.fingerprint as TasteFingerprint
        setTaste(tasteCache)
      }
    } catch { /* non-fatal */ }
  }, [])

  const fetchRadar = useCallback(async (force: boolean) => {
    setRadarLoading(true)
    setRadarError(null)
    try {
      const res = await window.electronAPI.getNewMusicRadar?.(force)
      if (res?.ok && res.candidates) {
        radarCache = res.candidates
        radarAtCache = res.generatedAt ?? Date.now()
        radarSummaryCache = res.fingerprintSummary ?? null
        anchorsCache = res.anchors ?? null
        setCandidates(res.candidates)
        setGeneratedAt(radarAtCache)
        if (res.anchors) setAnchors(res.anchors)
        if (res.fingerprintSummary && !tasteCache) {
          setTaste((t) => t ?? { summary: res.fingerprintSummary!, topGenres: [], spines: [], peakDecade: null })
        }
      } else {
        setRadarError(res?.error || 'Discovery is unavailable right now.')
      }
    } catch (e) {
      setRadarError(e instanceof Error ? e.message : 'Discovery failed.')
    } finally {
      setRadarLoading(false)
    }
  }, [])

  const fetchRediscovery = useCallback(async (force: boolean) => {
    setRediscoLoading(true)
    setRediscoError(null)
    try {
      const res = await window.electronAPI.getRediscovery?.(force)
      if (res?.ok && res.picks) {
        rediscoveryCache = res.picks
        rediscoveryAtCache = Date.now()
        setRediscovery(res.picks)
      } else {
        setRediscoError(res?.error || 'Rediscovery is unavailable right now.')
      }
    } catch (e) {
      setRediscoError(e instanceof Error ? e.message : 'Rediscovery failed.')
    } finally {
      setRediscoLoading(false)
    }
  }, [])

  const refreshAll = useCallback((force: boolean) => {
    void fetchTaste()
    void fetchRadar(force)
    void fetchRediscovery(force)
  }, [fetchTaste, fetchRadar, fetchRediscovery])

  useEffect(() => {
    void fetchTaste()
    if (radarCache === null) void fetchRadar(false)
    if (rediscoveryCache === null) void fetchRediscovery(false)
  }, [fetchTaste, fetchRadar, fetchRediscovery])

  useEffect(() => {
    const all = [...candidates]
    if (all.length === 0) return
    let cancelled = false
    for (const c of all) {
      const key = radarKey(c)
      if (enrichCache[key]) continue
      window.electronAPI.lookupRecoArtwork?.({ artist: c.artist, title: c.title }).then((r) => {
        if (cancelled || !r?.artworkUrl) return
        const entry = { art: r.artworkUrl, preview: r.previewUrl }
        enrichCache[key] = entry
        setEnriched((prev) => ({ ...prev, [key]: entry }))
      }).catch(() => { /* leave placeholder */ })
    }
    return () => { cancelled = true }
  }, [candidates])

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
          if (onList.has(`${norm(c.artist)}|${norm(c.title)}`)) next.add(radarKey(c))
        }
        return next
      })
    }).catch(() => { /* list unavailable */ })
    return () => { cancelled = true }
  }, [candidates])

  useEffect(() => () => stopPreview(), [])

  const handleAdd = useCallback(async (c: RadarCandidate) => {
    const key = radarKey(c)
    try {
      const res = await window.electronAPI.addRecommendation?.({
        song: c.title,
        artist: c.artist,
        note: c.why,
        source: 'radar',
      })
      if (res?.ok) {
        setAdded((prev) => new Set(prev).add(key))
        setNotice(
          res.deduped ? `“${c.title}” is already on your list.` : `Added “${c.title}” to your list.`,
          { kind: 'success' },
        )
      } else {
        setNotice(res?.error || "Couldn't add to your list.", { kind: 'error' })
      }
    } catch {
      setNotice("Couldn't add to your list.", { kind: 'error' })
    }
  }, [])

  const loading = radarLoading && candidates.length === 0 && rediscoLoading && rediscovery.length === 0
  const summary = taste?.summary || radarSummaryCache

  return (
    <div className="nfy">
      <div className="nfy-header">
        <div className="nfy-headtext">
          <h1 className="nfy-title">New for You</h1>
          <p className="nfy-sub">
            Picks based on what you actually play — not generic charts
            {generatedAt ? ` · updated ${formatAppDate(generatedAt)}` : ''}
          </p>
        </div>
        <button
          className="nfy-refresh"
          disabled={radarLoading || rediscoLoading}
          onClick={() => refreshAll(true)}
        >
          {(radarLoading || rediscoLoading) ? 'Digging…' : '↻ Refresh'}
        </button>
      </div>

      {summary && (
        <div className="nfy-taste">
          <span className="nfy-taste-label">Seeded from</span>
          {(anchors.length > 0 ? anchors : taste?.topArtists?.slice(0, 6).map((a) => ({ artist: a.artist, plays: a.plays, tracks: a.tracks, primaryGenre: '' })) ?? []).slice(0, 6).map((a) => (
            <span key={a.artist} className="nfy-anchor-chip" title={a.plays ? `${a.plays} plays` : undefined}>
              {a.artist}{a.plays > 0 ? ` (${a.plays})` : ''}
            </span>
          ))}
        </div>
      )}

      {loading && (
        <div className="nfy-loading">The Music Man is digging through the crates — matching fresh releases and overlooked gems to your library…</div>
      )}

      <section className="nfy-section">
        <div className="nfy-section-head">
          <h2 className="nfy-section-title">Fresh releases</h2>
          <span className="nfy-section-hint">New music connected to artists you play most</span>
        </div>
        {radarError && candidates.length === 0 && (
          <div className="nfy-error">{radarError}</div>
        )}
        {!radarLoading && !radarError && candidates.length === 0 && (
          <div className="nfy-empty">No fresh picks yet — hit Refresh once your Exa key is set.</div>
        )}
        <div className="nfy-grid">
          {candidates.map((c) => {
            const key = radarKey(c)
            const pct = Math.round(c.score * 100)
            const isAdded = added.has(key)
            const art = enriched[key]?.art
            const previewUrl = enriched[key]?.preview
            const isPlaying = previewState.playingId === key
            const reco = asReco(c)
            const canDl = canDownloadReco(reco)
            const dl = dlMap.get(reco.id) ?? getLtlDownloadStatus(reco.id)
            const dlBusy = isLtlDownloadBusy(reco.id)
            return (
              <div key={key} className="nfy-card">
                <div className="nfy-cover">
                  {art
                    ? <img src={art} alt={c.title} loading="lazy" />
                    : <div className="nfy-cover-ph">♫</div>}
                  <div className="nfy-match" title={`${pct}% taste match`}>{pct}%</div>
                  {previewUrl && (
                    <button
                      type="button"
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
                  {c.anchor && (
                    <div className="nfy-because">Because you play <strong>{c.anchor}</strong></div>
                  )}
                  <div className="nfy-meta">{[c.genre, c.year].filter(Boolean).join('  ·  ')}</div>
                  {c.reasons.length > 0 && (
                    <div className="nfy-reasons">
                      {c.reasons.slice(0, 2).map((r) => (
                        <span key={r} className="nfy-reason-chip">{r}</span>
                      ))}
                    </div>
                  )}
                  {c.why && <p className="nfy-why">{c.why}</p>}
                  <div className="nfy-actions">
                    <button type="button" className="nfy-add" disabled={isAdded} onClick={() => void handleAdd(c)}>
                      {isAdded ? '✓ On your list' : '+ Add to List'}
                    </button>
                    {canDl && (
                      <button
                        type="button"
                        className={`nfy-dl${dl.state === 'done' ? ' nfy-dl--done' : ''}${dl.state === 'error' ? ' nfy-dl--err' : ''}`}
                        disabled={dlBusy}
                        onClick={() => queueRecoDownload(reco)}
                        title={
                          dl.state === 'downloading' ? 'Downloading…'
                          : dl.state === 'done' ? 'Imported'
                          : 'Download via Qobuz'
                        }
                      >
                        {dl.state === 'downloading' || dl.state === 'queued' ? '…' : dl.state === 'done' ? '✓' : '↓'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="nfy-section nfy-section--redisco">
        <div className="nfy-section-head">
          <h2 className="nfy-section-title">Sleeping in your library</h2>
          <span className="nfy-section-hint">Artists you bought into but barely spun here — your Spotify blind spot</span>
        </div>
        {rediscoError && rediscovery.length === 0 && (
          <div className="nfy-error">{rediscoError}</div>
        )}
        {!rediscoLoading && !rediscoError && rediscovery.length === 0 && (
          <div className="nfy-empty nfy-empty--soft">Nothing overlooked right now — you&apos;re actually playing what you own.</div>
        )}
        <div className="nfy-redisco-list">
          {rediscovery.map((p) => (
            <div key={`${p.artist}|${p.album}`} className="nfy-redisco-row">
              <div className="nfy-redisco-main">
                <div className="nfy-redisco-artist">{p.artist}</div>
                {p.album && <div className="nfy-redisco-album">{p.album}</div>}
                <div className="nfy-redisco-stats">
                  {[p.genre, `${p.ownedTracks} owned`, p.plays === 0 ? 'never played here' : `${p.plays} plays here`].filter(Boolean).join(' · ')}
                </div>
              </div>
              <p className="nfy-redisco-why">{p.reason}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
