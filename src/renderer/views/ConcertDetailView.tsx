import { useMemo, useEffect, useState, useRef, useSyncExternalStore, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor, cueAt, promoteTrackToLibrary, unregisterLiveSet } from '../liveSets'
import { attachConcert, detachConcert, subscribeConcertCrowd, isConcertCrowdEnabled, setConcertCrowdEnabled, getCrowdParams, setCrowdParams } from '../concertCrowd'
import { getConcertKey, subscribeConcertKey } from '../concertNav'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from '../components/AlbumArtImage'
import ContextMenu from '../components/ContextMenu'
import type { LiveSetCue, Track } from '../types'
import '../styles/concerts.css'
import '../styles/concert-detail.css'

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
function parseMeta(show: string, sampleTitle: string, override?: { venue?: string; date?: string }): { venue?: string; date?: string } {
  if (override && (override.venue || override.date)) return { venue: override.venue, date: override.date }
  let venue: string | undefined, date: string | undefined
  const m = /\(live\s+(?:at|from)\s+([^,]+),\s*(.+?)\)\s*$/i.exec(sampleTitle || '')
  if (m) { venue = m[1].trim(); date = m[2].trim() }
  if (!date) { const d = /([A-Z][a-z]+\.?\s+\d[\d\s&,–-]*\d{4})/.exec(show || ''); if (d) date = d[1].trim() }
  return { venue, date }
}

export default function ConcertDetailView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack, seek } = useAudio()
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const albumKey = useSyncExternalStore(subscribeConcertKey, getConcertKey)
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  const liveSet = liveSetFor(albumKey, lib.tracks)
  const mergedTrack = liveSet ? (lib.tracks.find((t) => t.id === liveSet.mergedTrackId) ?? null) : null

  const meta = useMemo(() => {
    if (!liveSet) return { band: '', show: '', venue: undefined as string | undefined, date: undefined as string | undefined, artHash: undefined as string | undefined }
    const src = lib.tracks.find((t) => t.id === liveSet.cues[0]?.trackId)
    const band = liveSet.cues[0]?.artist || src?.artist || ''
    const show = src?.album?.replace(/\s*\(Live Set\)\s*$/i, '') || albumKey.split('|||')[1] || 'Live Concert'
    const { venue, date } = parseMeta(show, liveSet.cues[0]?.title || '', liveSet.concert)
    const artHash = liveSet.concert?.poster || lookupArtwork(lib.artworkMap, normalizedArtIndex, band, show)
    return { band, show, venue, date, artHash }
  }, [liveSet, lib.tracks, lib.artworkMap, normalizedArtIndex, albumKey])

  const setPlaying = !!(mergedTrack && pb.nowPlaying?.id === mergedTrack.id)
  const activeCue = liveSet && setPlaying ? cueAt(liveSet, pb.position * 1000) : null

  // A concert plays inside a queue of ALL concerts (each = its one merged
  // track), so the transport next/prev buttons move between CONCERTS and can
  // NEVER skip songs within a show — the show is one continuous piece. Picking
  // a song just seeks within the current track.
  const pendingSeekRef = useRef<number | null>(null)
  const playLiveSet = useCallback((startFrac?: number) => {
    if (!mergedTrack) return
    const sets = Object.values(getLiveSetsSnapshot().sets)
      .filter((e) => lib.tracks.some((t) => t.id === e.mergedTrackId))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    const queue = sets.map((e) => lib.tracks.find((t) => t.id === e.mergedTrackId)).filter(Boolean) as Track[]
    const idx = Math.max(0, queue.findIndex((t) => t.id === mergedTrack.id))
    pendingSeekRef.current = startFrac ?? null
    playTrack(mergedTrack, queue.length ? queue : [mergedTrack], idx, undefined, true)
  }, [mergedTrack, lib.tracks, playTrack])
  // Start-at-a-picked-song when the show isn't already playing: seek once it's up.
  useEffect(() => {
    if (setPlaying && pendingSeekRef.current != null) {
      const f = pendingSeekRef.current
      pendingSeekRef.current = null
      const t = setTimeout(() => seek(f), 400)
      return () => clearTimeout(t)
    }
  }, [setPlaying, seek])
  const jumpTo = useCallback((cue: LiveSetCue) => {
    if (!liveSet) return
    const frac = liveSet.totalDurationMs > 0 ? cue.startMs / liveSet.totalDurationMs : 0
    if (setPlaying) seek(frac)
    else playLiveSet(frac)   // start the show AT the song you picked
  }, [liveSet, setPlaying, seek, playLiveSet])

  // Crowd toggle + engine attach (same as the concert plays here now).
  const crowdOn = useSyncExternalStore(subscribeConcertCrowd, isConcertCrowdEnabled)
  const [crowdParams, setCrowdParamsLocal] = useState(getCrowdParams())
  useEffect(() => subscribeConcertCrowd(() => setCrowdParamsLocal(getCrowdParams())), [])
  const crowdMergedId = mergedTrack?.id
  const crowdCues = liveSet?.cues
  const crowdTotalMs = liveSet?.totalDurationMs
  useEffect(() => {
    if (crowdMergedId == null || !crowdCues || !crowdTotalMs) return
    void attachConcert(crowdMergedId, crowdCues.map((c) => c.startMs / 1000), crowdTotalMs / 1000)
    return () => { detachConcert() }
  }, [crowdMergedId, crowdCues, crowdTotalMs])

  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: LiveSetCue } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // The concert poster IS the artwork — make it dead-easy to set the real one:
  // drop an image on it, or click to choose. Grounded (your image), never
  // fabricated. Reuses the app's custom-artwork pipeline keyed by band+show.
  const [posterDrag, setPosterDrag] = useState(false)
  const applyPoster = useCallback(async (path: string) => {
    if (!path || !meta.band || !meta.show) return
    const r = await window.electronAPI.setCustomArtwork(meta.band, meta.show, path)
    if (r.ok && r.key && r.hash) libDispatch({ type: 'ADD_ARTWORK', key: r.key, hash: r.hash })
  }, [meta.band, meta.show, libDispatch])
  const onPosterDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setPosterDrag(false)
    const f = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    if (f && f.type.startsWith('image/') && f.path) void applyPoster(f.path)
  }, [applyPoster])
  const choosePoster = useCallback(async () => {
    const file = await window.electronAPI.chooseArtworkFile()
    if (file.ok && file.path) void applyPoster(file.path)
  }, [applyPoster])
  const handleUndeclare = useCallback(async () => {
    if (!liveSet) return
    // Identity-gated: only the merged track id is deleted; the individual songs
    // are untouched by construction. Then back to the concerts list.
    libDispatch({ type: 'DELETE_TRACKS', ids: [liveSet.mergedTrackId] })
    await unregisterLiveSet(albumKey)
    libDispatch({ type: 'SET_VIEW', view: 'concerts' })
  }, [liveSet, albumKey, libDispatch])

  if (!liveSet || !mergedTrack) {
    return (
      <div className="concert-detail">
        <button className="concert-back" onClick={() => libDispatch({ type: 'SET_VIEW', view: 'concerts' })}>← Live Concerts</button>
        <div className="concerts-empty">This concert is no longer available.</div>
      </div>
    )
  }

  const posMs = pb.position * 1000
  const promoted = new Set(liveSet.promotedTrackIds || [])

  return (
    <div className="concert-detail">
      <button className="concert-back" onClick={() => libDispatch({ type: 'SET_VIEW', view: 'concerts' })}>← Live Concerts</button>

      <div className="concert-hero">
        <div
          className={`concert-hero-poster${posterDrag ? ' is-drag' : ''}`}
          onClick={choosePoster}
          onDrop={onPosterDrop}
          onDragOver={(e) => { e.preventDefault(); if (!posterDrag) setPosterDrag(true) }}
          onDragLeave={() => setPosterDrag(false)}
          role="button"
          title="Drop a concert poster here, or click to choose one"
        >
          {meta.artHash
            ? <AlbumArtImage hash={meta.artHash} alt={meta.show} className="concert-hero-img" size={320} />
            : <div className="concert-hero-noart" aria-hidden="true" />}
          <div className="concert-hero-poster-hint"><span>{posterDrag ? 'Drop poster' : 'Set poster'}</span></div>
        </div>
        <div className="concert-hero-meta">
          <div className="concert-hero-band">{meta.band}</div>
          <h1 className="concert-hero-show">{meta.show}</h1>
          <div className="concert-hero-where">
            {[meta.venue, meta.date].filter(Boolean).join(' · ') || `${liveSet.cues.length} songs`}
          </div>
          <div className="concert-hero-stat">{liveSet.cues.length} songs · {hms(liveSet.totalDurationMs)} · one continuous set</div>
          <div className="concert-hero-actions">
            <button className="concert-btn concert-btn--play" onClick={playLiveSet}>▶ {setPlaying ? 'Playing' : 'Play the Show'}</button>
            <button
              className={`concert-btn concert-btn--crowd${crowdOn ? ' is-on' : ''}`}
              onClick={() => setConcertCrowdEnabled(!crowdOn)}
              title="Swell that night's crowd in the gaps between songs — off by default"
            >{crowdOn ? '◉ Crowd on' : '◎ Crowd'}</button>
            <button
              className="concert-btn concert-btn--remove"
              onClick={() => { if (confirmRemove) void handleUndeclare(); else setConfirmRemove(true) }}
              onMouseLeave={() => setConfirmRemove(false)}
              title="Remove this concert — the individual songs are unaffected"
            >{confirmRemove ? 'Remove concert?' : 'Undeclare'}</button>
          </div>
          {crowdOn && (
            <div className="concert-crowd-panel">
              <div className="ccp-title">Crowd — dial it in by ear (that night's audience, in the gaps)</div>
              <label className="ccp-row">
                <span>Level</span>
                <input type="range" min="0" max="1" step="0.05" value={crowdParams.level}
                  onChange={(e) => void setCrowdParams({ level: Number(e.target.value) })} />
                <em>{crowdParams.level <= 0.02 ? 'off' : `${Math.round(crowdParams.level * 100)}%`}</em>
              </label>
              <label className="ccp-row">
                <span>Rise</span>
                <input type="range" min="0.5" max="8" step="0.5" value={crowdParams.rise}
                  onChange={(e) => void setCrowdParams({ rise: Number(e.target.value) })} />
                <em>{crowdParams.rise.toFixed(1)}s before</em>
              </label>
              <label className="ccp-row">
                <span>Tail</span>
                <input type="range" min="0.3" max="5" step="0.1" value={crowdParams.tail}
                  onChange={(e) => void setCrowdParams({ tail: Number(e.target.value) })} />
                <em>{crowdParams.tail.toFixed(1)}s after</em>
              </label>
            </div>
          )}
        </div>
      </div>

      {/* The setlist journey — you travel down the show. */}
      <div className="concert-journey">
        {liveSet.cues.map((cue, i) => {
          const state = activeCue
            ? (i < activeCue.index ? 'played' : i === activeCue.index ? 'current' : 'upcoming')
            : 'idle'
          const inLib = promoted.has(cue.trackId)
          const elapsed = state === 'current' ? Math.max(0, posMs - cue.startMs) : 0
          const frac = state === 'current' && cue.durationMs > 0 ? Math.min(1, elapsed / cue.durationMs) : 0
          return (
            <div
              key={`${cue.trackId}-${i}`}
              className={`cj-row cj-row--${state}`}
              onClick={() => jumpTo(cue)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCueCtx({ x: e.clientX, y: e.clientY, cue }) }}
              role="button"
              title={setPlaying ? `Jump to "${cue.title.replace(/\s*\(Live.*/, '')}"` : 'Play the show — right-click a song to add it to your library'}
            >
              <div className="cj-rail">
                <div className="cj-line cj-line--top" />
                <div className="cj-node" />
                <div className="cj-line cj-line--bot" />
              </div>
              {state === 'current' ? (
                <div className="cj-card">
                  <div className="cj-card-tag">NOW PLAYING · {i + 1} OF {liveSet.cues.length}</div>
                  <div className="cj-card-title">{cue.title.replace(/\s*\(Live.*/, '')}{inLib && <span className="cj-inlib" title="In your library">✓</span>}</div>
                  <div className="cj-card-prog">
                    <div className="cj-card-bar"><div className="cj-card-fill" style={{ width: `${Math.round(frac * 100)}%` }} /></div>
                    <span className="cj-card-time">{mmss(elapsed)} / {mmss(cue.durationMs)}</span>
                  </div>
                </div>
              ) : (
                <div className="cj-song">
                  <span className="cj-num">{i + 1}</span>
                  <span className="cj-name">{cue.title.replace(/\s*\(Live.*/, '')}{inLib && <span className="cj-inlib" title="In your library">✓</span>}</span>
                  <span className="cj-dur" title="Starts at this point in the show">{hms(cue.startMs)}</span>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {cueCtx && (
        <ContextMenu
          x={cueCtx.x}
          y={cueCtx.y}
          items={
            promoted.has(cueCtx.cue.trackId)
              ? [{ label: 'Already in your library', onClick: () => {}, disabled: true }]
              : [{ label: `Add "${cueCtx.cue.title.replace(/\s*\(Live.*/, '')}" to My Library`, onClick: () => { void promoteTrackToLibrary(albumKey, cueCtx.cue.trackId) } }]
          }
          onClose={() => setCueCtx(null)}
        />
      )}
    </div>
  )
}
