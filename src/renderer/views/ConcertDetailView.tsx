/**
 * ConcertDetailView — the concert page ("the setlist journey", LC-8), rebuilt
 * 2026-09-02 as the marquee ("extreme makeover, home edition" — Jake).
 *
 *   • HERO: the cover as a soft wash behind a silver panel, the poster at its
 *     own aspect (a square cover stays square; a real gig poster stands
 *     tall), band eyebrow, the show in display serif, the VENUE as a lockup,
 *     a ticket stub for nights + set. Play / Crowd / Undeclare.
 *   • THE SHOW, START TO FINISH: a timeline strip — one segment per song,
 *     sized by length; played segments toned, the current one lit; hover
 *     names the song, click seeks there.
 *   • THE PROGRAM: the same spine + rows (cs-/cj- classes, shared with the
 *     album page's setlist), with `concert.segments` dividers, in a two-
 *     column body next to a sticky companion: The night, At a glance, Your
 *     notes. Nothing is stated twice.
 *   • CROWD: the button reads its own readiness — a show with no clip yet
 *     asks main to cut one from its own tape (concert-crowd-extract) and
 *     says "Preparing the crowd…" until it lands.
 *
 * Palette: white / silver / charcoal / one orange (the 2011 direction).
 * No brown. concert-stage.css owns the new classes; concert-detail.css keeps
 * the shared program rows, recoloured here under .cd-stage.
 */
import React, { useMemo, useEffect, useState, useRef, useSyncExternalStore, useCallback } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, liveSetFor, cueAt, promoteTrackToLibrary, unregisterLiveSet, updateConcertMeta, cleanLiveTitle as cleanTitle } from '../liveSets'
import { attachConcert, detachConcert, subscribeConcertCrowd, isConcertCrowdEnabled, setConcertCrowdEnabled, getCrowdParams, setCrowdParams } from '../concertCrowd'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getConcertKey, subscribeConcertKey } from '../concertNav'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from '../components/AlbumArtImage'
import ContextMenu from '../components/ContextMenu'
import type { LiveSetCue, Track } from '../types'
import '../styles/concerts.css'
import '../styles/concert-detail.css'
import '../styles/concert-stage.css'

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
/** Round ticks for the strip: every 30 min up to the show's length. */
function stripTicks(totalMs: number): number[] {
  const step = 30 * 60 * 1000
  const out: number[] = []
  for (let t = 0; t < totalMs; t += step) out.push(t)
  out.push(totalMs)
  return out
}

export default function ConcertDetailView() {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack, seek } = useAudio()
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  const albumKey = useSyncExternalStore(subscribeConcertKey, getConcertKey)
  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const concertPageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(`concert:${albumKey}`, concertPageRef)

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
  useEffect(() => {
    if (setPlaying && pendingSeekRef.current != null) {
      const f = pendingSeekRef.current
      pendingSeekRef.current = null
      const t = setTimeout(() => seek(f), 400)
      return () => clearTimeout(t)
    }
  }, [setPlaying, seek])
  const seekFrac = useCallback((frac: number) => {
    const f = Math.max(0, Math.min(0.9999, frac))
    if (setPlaying) seek(f)
    else playLiveSet(f)   // start the show AT the point you picked
  }, [setPlaying, seek, playLiveSet])
  const jumpTo = useCallback((cue: LiveSetCue) => {
    if (!liveSet) return
    seekFrac(liveSet.totalDurationMs > 0 ? cue.startMs / liveSet.totalDurationMs : 0)
  }, [liveSet, seekFrac])

  // ── Crowd: readiness + attach ─────────────────────────────────────────
  const crowdOn = useSyncExternalStore(subscribeConcertCrowd, isConcertCrowdEnabled)
  const [crowdParams, setCrowdParamsLocal] = useState(getCrowdParams())
  useEffect(() => subscribeConcertCrowd(() => setCrowdParamsLocal(getCrowdParams())), [])
  const crowdMergedId = mergedTrack?.id
  const crowdCues = liveSet?.cues
  const crowdTotalMs = liveSet?.totalDurationMs
  const crowdPath = mergedTrack?.path
  const [crowdState, setCrowdState] = useState<'unknown' | 'ready' | 'preparing' | 'none'>('unknown')
  useEffect(() => {
    if (crowdMergedId == null || !crowdCues || !crowdTotalMs) return
    let cancelled = false
    const attach = (): Promise<void> => attachConcert(crowdMergedId, crowdCues.map((c) => c.startMs / 1000), crowdTotalMs / 1000)
    void (async () => {
      const has = await window.electronAPI.getConcertCrowd(crowdMergedId)
      if (cancelled) return
      if (has) { setCrowdState('ready'); await attach(); return }
      // No clip yet — cut one from this show's own tape, then attach.
      setCrowdState('preparing')
      const r = await window.electronAPI.extractConcertCrowd(crowdMergedId, crowdPath || '', crowdCues.map((c) => c.startMs), crowdTotalMs)
      if (cancelled) return
      if (r.ok) { setCrowdState('ready'); await attach() } else setCrowdState('none')
    })()
    return () => { cancelled = true; detachConcert() }
  }, [crowdMergedId, crowdCues, crowdTotalMs, crowdPath])

  const [cueCtx, setCueCtx] = useState<{ x: number; y: number; cue: LiveSetCue } | null>(null)
  const savedNotes = liveSet?.concert?.notes ?? ''
  const [notesDraft, setNotesDraft] = useState('')
  useEffect(() => { setNotesDraft(savedNotes) }, [savedNotes])
  const saveNotes = useCallback(() => {
    if (notesDraft !== savedNotes) void updateConcertMeta(albumKey, { notes: notesDraft })
  }, [notesDraft, savedNotes, albumKey])
  const [confirmRemove, setConfirmRemove] = useState(false)

  // The poster IS the artwork — drop an image on it, or click to choose.
  const [posterDrag, setPosterDrag] = useState(false)
  const applyPoster = useCallback(async (path: string) => {
    if (!path || !meta.band || !meta.show) return
    const r = await window.electronAPI.setCustomArtwork(meta.band, meta.show, path)
    if (r.ok && r.key && r.hash) {
      libDispatch({ type: 'ADD_ARTWORK', key: r.key, hash: r.hash })
      // The image you just set IS the poster: a persisted concert.poster
      // (the seeded ones) would otherwise keep winning over it.
      if (liveSet?.concert?.poster) void updateConcertMeta(albumKey, { poster: '' })
    }
  }, [meta.band, meta.show, libDispatch, liveSet?.concert?.poster, albumKey])
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
    libDispatch({ type: 'DELETE_TRACKS', ids: [liveSet.mergedTrackId] })
    await unregisterLiveSet(albumKey)
    libDispatch({ type: 'SET_VIEW', view: 'concerts' })
  }, [liveSet, albumKey, libDispatch])

  const stripRef = useRef<HTMLDivElement>(null)
  const onStripClick = useCallback((e: React.MouseEvent) => {
    const el = stripRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0) return
    seekFrac((e.clientX - r.left) / r.width)
  }, [seekFrac])

  if (!liveSet || !mergedTrack) {
    return (
      <div className="concert-detail cd-stage" ref={concertPageRef}>
        <button className="concert-back" onClick={() => libDispatch({ type: 'SET_VIEW', view: 'concerts' })}>← Live Concerts</button>
        <div className="concerts-empty">This concert is no longer available.</div>
      </div>
    )
  }

  const posMs = pb.position * 1000
  const promoted = new Set(liveSet.promotedTrackIds || [])
  const maxDurMs = Math.max(1, ...liveSet.cues.map((c) => c.durationMs))
  const allPromoted = liveSet.cues.every((c) => promoted.has(c.trackId))
  const bandLc = meta.band.toLowerCase().trim()
  const dividers = new Map<number, string>()
  for (const s of liveSet.concert?.segments || []) {
    if (s && typeof s.before === 'number' && s.label) dividers.set(s.before, s.label)
  }
  const c = liveSet.concert || {}
  const facts = c.facts || []
  const longest = liveSet.cues.reduce((a, b) => (b.durationMs > a.durationMs ? b : a), liveSet.cues[0])
  const encoreAt = [...dividers.entries()].find(([, label]) => /encore/i.test(label))?.[0]
  const encoreCount = encoreAt != null ? liveSet.cues.length - (encoreAt - 1) : null
  const totalMs = Math.max(1, liveSet.totalDurationMs)
  const artUrl = meta.artHash ? `album-art://${meta.artHash}.jpg?s=640` : null
  const crowdLabel = crowdState === 'preparing' ? 'Preparing the crowd…' : crowdOn ? '◉ Crowd on' : '◎ Crowd'

  return (
    <div className="concert-detail cd-stage" ref={concertPageRef}>
      <button className="concert-back" onClick={() => libDispatch({ type: 'SET_VIEW', view: 'concerts' })}>← Live Concerts</button>

      <section className="cd-hero">
        {artUrl && <div className="cd-hero-wash" style={{ backgroundImage: `url("${artUrl}")` }} aria-hidden="true" />}
        <div className="cd-hero-veil" aria-hidden="true" />
        <div
          className={`cd-poster${posterDrag ? ' is-drag' : ''}`}
          onClick={choosePoster}
          onDrop={onPosterDrop}
          onDragOver={(e) => { e.preventDefault(); if (!posterDrag) setPosterDrag(true) }}
          onDragLeave={() => setPosterDrag(false)}
          role="button"
          title="Drop a concert poster here, or click to choose one"
        >
          {meta.artHash
            ? <AlbumArtImage hash={meta.artHash} alt={meta.show} className="cd-poster-img" size={640} />
            : <div className="cd-poster-noart" aria-hidden="true" />}
          <div className="cd-poster-hint"><span>{posterDrag ? 'Drop poster' : 'Set poster'}</span></div>
        </div>
        <div className="cd-hero-meta">
          <div className="cd-eyebrow">{meta.band}</div>
          <h1 className="cd-title">{meta.show}</h1>
          {(meta.venue || c.city) && (
            <div className="cd-venue">
              {meta.venue && <div className="cd-venue-name">{meta.venue}</div>}
              {c.city && <div className="cd-venue-city">{c.city}</div>}
            </div>
          )}
          <div className="cd-stub">
            {meta.date && <div><b>{/[&,–-]/.test(meta.date) ? 'Nights' : 'Night'}</b><span>{meta.date}</span></div>}
            <div><b>Set</b><span>{liveSet.cues.length} songs · {hms(liveSet.totalDurationMs)}</span></div>
            {c.label && <div><b>Release</b><span>{c.label}</span></div>}
          </div>
          <div className="cd-actions">
            {/* Wrapped, NOT passed directly: React's MouseEvent would land in startFrac. */}
            <button className="cd-btn cd-btn--play" onClick={() => playLiveSet()}>▶ {setPlaying ? 'Playing' : 'Play the show'}</button>
            <button
              className={`cd-btn cd-btn--crowd${crowdOn ? ' is-on' : ''}${crowdState === 'preparing' ? ' is-busy' : ''}`}
              onClick={() => { if (crowdState !== 'preparing') setConcertCrowdEnabled(!crowdOn) }}
              disabled={crowdState === 'none'}
              title={crowdState === 'none' ? 'No usable crowd window was found on this tape' : "Swell that night's crowd in the gaps between songs — off by default"}
            >{crowdLabel}</button>
            <button
              className="cd-btn cd-btn--remove"
              onClick={() => { if (confirmRemove) void handleUndeclare(); else setConfirmRemove(true) }}
              onMouseLeave={() => setConfirmRemove(false)}
              title="Remove this concert — the individual songs are unaffected"
            >{confirmRemove ? 'Remove concert?' : 'Undeclare'}</button>
          </div>
          {crowdOn && crowdState === 'ready' && (
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
      </section>

      {/* The show, start to finish — one segment per song, click to seek. */}
      <section className="cd-strip" aria-label="The show, start to finish">
        <div className="cd-strip-head">
          <span>The show, start to finish</span>
          <span>{activeCue ? <><b>{cleanTitle(activeCue.cue.title)}</b> · {hms(posMs)}</> : hms(liveSet.totalDurationMs)}</span>
        </div>
        <div className="cd-bar" ref={stripRef} onClick={onStripClick} role="slider" aria-valuemin={0} aria-valuemax={totalMs} aria-valuenow={setPlaying ? Math.round(posMs) : 0}>
          {liveSet.cues.map((cue, i) => {
            const state = activeCue ? (i < activeCue.index ? 'done' : i === activeCue.index ? 'now' : 'todo') : 'todo'
            return (
              <div
                key={`${cue.trackId}-${i}`}
                className={`cd-seg${state === 'done' ? ' cd-seg--done' : state === 'now' ? ' cd-seg--now' : ''}`}
                style={{ flex: `${Math.max(1, cue.durationMs)} 0 0` }}
                title={`${cleanTitle(cue.title)} · ${mmss(cue.durationMs)} · at ${hms(cue.startMs)}`}
              />
            )
          })}
        </div>
        <div className="cd-ticks" aria-hidden="true">
          {stripTicks(liveSet.totalDurationMs).map((t) => <span key={t}>{hms(t)}</span>)}
        </div>
      </section>

      <div className="cd-grid">
        {/* The program: the same spine + rows the album page's setlist uses. */}
        <div className="concert-sheet">
          <div className="cs-head">
            <span className="cs-head-title">Set list</span>
            <span className="cs-head-rule" aria-hidden="true" />
          </div>
          <div className="cs-cols" aria-hidden="true">
            <span className="cs-cols-song">Song</span>
            <span className="cs-cols-len">Length</span>
            <span className="cs-cols-at">At</span>
          </div>
          <div className="concert-journey">
            {liveSet.cues.map((cue, i) => {
              const state = activeCue
                ? (i < activeCue.index ? 'played' : i === activeCue.index ? 'current' : 'upcoming')
                : 'idle'
              const inLib = !allPromoted && promoted.has(cue.trackId)
              const guest = (cue.artist || '').toLowerCase().trim() !== bandLc ? cue.artist : null
              const elapsed = state === 'current' ? Math.max(0, posMs - cue.startMs) : 0
              const frac = state === 'current' && cue.durationMs > 0 ? Math.min(1, elapsed / cue.durationMs) : 0
              const divider = dividers.get(i + 1)
              return (
                <React.Fragment key={`${cue.trackId}-${i}`}>
                  {divider && (
                    <div className={`cs-divider${/encore/i.test(divider) ? ' cs-divider--encore' : ''}`} aria-label={divider}>
                      <span className="cs-divider-rule" /><span className="cs-divider-label">{divider}</span><span className="cs-divider-rule" />
                    </div>
                  )}
                  <div
                    className={`cj-row cj-row--${state}`}
                    onClick={() => jumpTo(cue)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCueCtx({ x: e.clientX, y: e.clientY, cue }) }}
                    role="button"
                    title={setPlaying ? `Jump to "${cleanTitle(cue.title)}"` : 'Play the show — right-click a song to add it to your library'}
                  >
                    <div className="cj-rail">
                      <div className="cj-line cj-line--top" />
                      <div className="cj-node" />
                      <div className="cj-line cj-line--bot" />
                    </div>
                    {state === 'current' ? (
                      <div className="cj-card">
                        <div className="cj-card-tag">NOW PLAYING · {i + 1} OF {liveSet.cues.length}</div>
                        <div className="cj-card-title">{cleanTitle(cue.title)}{guest && <span className="cj-guest">{guest}</span>}{inLib && <span className="cj-inlib" title="In your library">✓</span>}</div>
                        <div className="cj-card-prog">
                          <div className="cj-card-bar"><div className="cj-card-fill" style={{ width: `${Math.round(frac * 100)}%` }} /></div>
                          <span className="cj-card-time">{mmss(elapsed)} / {mmss(cue.durationMs)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="cj-song">
                        <span className="cj-num">{String(i + 1).padStart(2, '0')}</span>
                        <span className="cj-name">
                          <span className="cj-name-text">{cleanTitle(cue.title)}</span>
                          {guest && <span className="cj-guest">{guest}</span>}
                          {inLib && <span className="cj-inlib" title="In your library">✓</span>}
                        </span>
                        <span className="cj-lane" aria-hidden="true"><span className="cj-lane-bar" style={{ width: `${Math.max(6, Math.round((cue.durationMs / maxDurMs) * 100))}%` }} /></span>
                        <span className="cj-len">{mmss(cue.durationMs)}</span>
                        <span className="cj-at" title="Starts at this point in the show">{hms(cue.startMs)}</span>
                      </div>
                    )}
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>

        {/* Companion — grounded facts, the shape of the night, your notes. */}
        <aside className="cd-side">
          {facts.length > 0 && (
            <div className="cd-card">
              <h4>The night</h4>
              <ul className="cd-facts">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              {c.merchUrl && <a className="cd-merch" href={c.merchUrl} title="Find merch for this show">Merch table ↗</a>}
            </div>
          )}
          <div className="cd-card">
            <h4>At a glance</h4>
            <div className="cd-glance">
              <div><b>Opens with</b><span title={cleanTitle(liveSet.cues[0].title)}>{cleanTitle(liveSet.cues[0].title)}</span></div>
              <div><b>Closes with</b><span title={cleanTitle(liveSet.cues[liveSet.cues.length - 1].title)}>{cleanTitle(liveSet.cues[liveSet.cues.length - 1].title)}</span></div>
              <div><b>Longest</b><span title={cleanTitle(longest.title)}>{cleanTitle(longest.title)} · {mmss(longest.durationMs)}</span></div>
              {encoreCount != null
                ? <div><b>Encore</b><span>{encoreCount} song{encoreCount === 1 ? '' : 's'}</span></div>
                : <div><b>Songs in your library</b><span>{allPromoted ? 'all of them' : `${promoted.size} of ${liveSet.cues.length}`}</span></div>}
            </div>
          </div>
          <div className="cd-card">
            <h4>Your notes</h4>
            <textarea
              className="cd-notes"
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              onBlur={saveNotes}
              placeholder="Were you there? What do you remember about this night…"
            />
          </div>
        </aside>
      </div>

      {cueCtx && (
        <ContextMenu
          x={cueCtx.x}
          y={cueCtx.y}
          items={
            promoted.has(cueCtx.cue.trackId)
              ? [{ label: 'Already in your library', onClick: () => {}, disabled: true }]
              : [{ label: `Add "${cleanTitle(cueCtx.cue.title)}" to My Library`, onClick: () => { void promoteTrackToLibrary(albumKey, cueCtx.cue.trackId) } }]
          }
          onClose={() => setCueCtx(null)}
        />
      )}
    </div>
  )
}
