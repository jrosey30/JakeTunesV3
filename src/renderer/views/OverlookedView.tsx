/**
 * Overlooked (Jake, 2026-10-22: "a place to browse but also done for me ...
 * AI brain oriented because it should know what I like WITHIN my library ...
 * focus more on songs"). Songs you own and have barely played, picked by the
 * taste brain — a "Best bets" lane, then one lane per genre the brain rates
 * highest — each with its reason from real stars, plays and genre. Click a
 * song and it plays with the rest of its lane queued behind it.
 *
 * homemini does the ranking (the hidden-gems rulebook, deeper); this view only
 * draws it: main/overlooked-client.ts → common/overlooked-doc.ts. The cards
 * are Home's album card, so a song here looks like a song on Home.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AlbumArtImage from '../components/AlbumArtImage'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { albumKeyOf } from '../utils/albumKey'
import { buildNormalizedArtworkIndex, lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import { setTrackDragPayload } from '../utils/trackDrag'
import type { Overlooked } from '../../common/overlooked-doc'
import type { Track } from '../types'

type LoadState = { phase: 'loading' } | { phase: 'ready'; doc: Overlooked; source: string } | { phase: 'empty' }

function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action() }
  }
}

export default function OverlookedView(): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' })
  const askedRef = useRef(false)

  const fetchDoc = useCallback(async (force: boolean) => {
    const res = await window.electronAPI?.overlookedGet?.(force).catch(() => null)
    const st = res?.ok ? res.state : undefined
    setLoad(st?.doc ? { phase: 'ready', doc: st.doc, source: st.source } : { phase: 'empty' })
  }, [])

  useEffect(() => {
    if (askedRef.current) return
    askedRef.current = true
    void fetchDoc(false)
  }, [fetchDoc])

  const byId = useMemo(() => {
    const m = new Map<number, Track>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artFor = useCallback((t: Track): string | undefined => {
    const key = albumKeyOf(t)
    if (lib.artworkMap[key]) return lib.artworkMap[key]
    return lookupArtwork(lib.artworkMap, artIndex, t.albumArtist || t.artist || '', t.album || '')
  }, [lib.artworkMap, artIndex])

  // Lanes resolved to this Mac's own songs; a song the library no longer has is skipped.
  const lanes = useMemo(() => (load.phase !== 'ready' ? [] : load.doc.lanes.map((lane) => ({
    genre: lane.genre,
    subtitle: lane.subtitle,
    cards: lane.items.flatMap((it) => { const track = byId.get(it.id); return track ? [{ track, reason: it.reason }] : [] }),
  })).filter((l) => l.cards.length > 0)), [load, byId])

  useEffect(() => {
    const all = lanes.flatMap((l) => l.cards.map((c) => c.track))
    const missing = all.filter((t) => !artFor(t)).map((t) => ({ artist: t.albumArtist || t.artist || '', album: t.album || '' }))
    if (missing.length) queueArtworkResolutions(missing, dispatch)
    prefetchAlbumArtHashes(all.slice(0, 40).map(artFor), 320)
  }, [lanes, artFor, dispatch])

  return (
    <div className="home-view overlooked-view">
      <section className="home-section" aria-label="Overlooked">
        <div className="home-section-header">
          <h2 className="home-section-title">Overlooked</h2>
          <button type="button" className="home-section-more" onClick={() => { setLoad({ phase: 'loading' }); void fetchDoc(true) }}>Refresh</button>
        </div>
        <p className="overlooked-lede">Songs you own but have barely played, matched to what you’re playing lately: artists you’ve never touched, and deep cuts from ones you know. A fresh set every morning.</p>
      </section>
      {load.phase === 'loading' && <p className="overlooked-note">Finding songs…</p>}
      {load.phase === 'empty' && <p className="overlooked-note">Nothing to show yet. Overlooked comes from homemini, and it isn’t answering right now.</p>}
      {lanes.map((lane) => {
        const title = lane.genre ?? 'Best Bets'
        const queue = lane.cards.map((c) => c.track)
        return (
          <section key={title} className="home-section home-shelves-row" aria-label={title}>
            <div className="home-section-header">
              <h2 className="home-section-title">{title}</h2>
              {lane.subtitle && <span className="overlooked-sub">{lane.subtitle}</span>}
              <button type="button" className="home-section-more" onClick={() => playTrack(queue[0]!, queue, 0, undefined, true, true)}>Play All</button>
            </div>
            <div className="home-card-row" role="list">
              {lane.cards.map((c, i) => {
                const hash = artFor(c.track)
                const play = () => playTrack(c.track, queue, i, undefined, true, true)
                return (
                  <div
                    key={c.track.id}
                    className="home-album-card home-album-card--shelf"
                    role="listitem"
                    tabIndex={0}
                    onClick={play}
                    onKeyDown={activateOnKey(play)}
                    draggable
                    onDragStart={(e) => setTrackDragPayload(e, c.track.id)}
                    title={`${c.track.title} — ${c.track.artist}\nClick plays it, with the rest of this lane after it.`}
                  >
                    <div className="home-album-art">
                      {hash
                        ? <AlbumArtImage hash={hash} alt={c.track.album || c.track.title} onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')} />
                        : <div className="home-album-art-placeholder" />}
                    </div>
                    <div className="home-album-info">
                      <div className="home-album-title">{c.track.title}</div>
                      <div className="home-album-artist">{c.track.artist}</div>
                      <div className="home-shelves-note">{c.reason}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
