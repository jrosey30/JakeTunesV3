/**
 * The three Home rows right under launch page "G" (Jake, 2026-10-20: "you
 * should listen to more, songs you've been listening to a lot, and recently
 * added. 5 each. With a see all option bringing it to 10."):
 *
 *   You Should Listen To More       hidden gems you own — the taste score's
 *                                   picks you've barely played, each with a
 *                                   reason from real stars / plays / genre
 *   You've Been Listening To A Lot  most plays in 30 days, with the count
 *   Recently Added                  newest songs, with the date added (a click
 *                                   plays it with the newest 25 queued behind)
 *
 * Five cards each. You Should Listen To More's "See All" opens Listen More
 * Weekly (2026-10-20: homemini's weekly playlist, whose first songs the row
 * is) — or, with no copy of it yet, grows to ten in place like the second
 * row; "See All 10" opens that row to ten in place (the
 * same grid-in-place Shows uses); Recently Added's "See All" opens the Recently
 * Added playlist, as the old row did (Jake, mid-build: "should bring you to
 * recently added playlist"). Click a song → it plays, with the rest of the row
 * queued behind it in order (Recently Added queues its newest 25, not just
 * the 5 shown); the album is one right-click away (Go to Album).
 *
 * Like a library row (Jake, 2026-10-20): right-click a song for the Songs
 * view's song menu, an album for the Albums view's album menu
 * (HomeItemMenus); drag either onto Up Next, a sidebar playlist or the iPod
 * Pool (the library's drag payload, utils/trackDrag.ts).
 *
 * The rows come from homemini's merged-history document (renderer/
 * homeShelves.ts), this Mac's own when homemini is away. The cards are Home's
 * album card (.home-album-card), with names that wrap instead of clipping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AlbumArtImage from './AlbumArtImage'
import { useHomeShelves } from '../homeShelves'
import { useListenMoreWeekly } from '../listenMoreWeekly'
import { albumKeyOf } from '../utils/albumKey'
import { lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { prefetchAlbumArtHashes } from '../utils/artworkPrefetch'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useHomeItemMenus } from './HomeItemMenus'
import { setTrackDragPayload } from '../utils/trackDrag'
import { SHELF_SHOWN, SHELF_MAX, playsLabel, addedLabel, recentlyAddedSongs, recentlyAddedPlay } from '../../common/home-shelves'
import { isTop25Rankable } from '../../common/top25-rankable'
import type { Track } from '../types'

type ShelfAction =
  | { type: 'VIEW_SMART_PLAYLIST'; id: 'recently-added' | 'listen-more-weekly' }
  | { type: 'ADD_ARTWORK'; key: string; hash: string }

interface Props {
  /** The whole library (ids resolve here). */
  tracks: Track[]
  /** HomeView's REGULAR projection — a declared concert's songs never show. */
  regularTracks: Track[]
  artworkMap: Record<string, string>
  artIndex: Map<string, string>
  dispatch: (action: ShelfAction) => void
  playTrack: (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void
}

interface SongCard { track: Track; note: string; count: boolean }

function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action() }
  }
}

function Placeholder(): JSX.Element {
  return (
    <div className="home-album-art-placeholder">
      <svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="#999" strokeWidth="1.5" aria-hidden="true">
        <circle cx="20" cy="20" r="18" />
        <circle cx="20" cy="20" r="6" />
        <circle cx="20" cy="20" r="2" fill="#999" />
      </svg>
    </div>
  )
}

function SongRow({ title, scrollKey, cards, artFor, playTrack, openAll, fullQueue }: {
  title: string
  scrollKey: string
  cards: SongCard[]
  artFor: (t: Track) => string | undefined
  playTrack: Props['playTrack']
  /** When set, "See All" opens this (a playlist) instead of growing the row. */
  openAll?: () => void
  /** Click queues this whole list (the row shows its first few); default: the shown cards. */
  fullQueue?: Track[]
}): JSX.Element {
  const [all, setAll] = useState(false)
  const menus = useHomeItemMenus()
  const groupRef = useRef<HTMLElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(scrollKey, rowRef)
  const shown = cards.slice(0, all ? SHELF_MAX : SHELF_SHOWN)
  const more = cards.length > SHELF_SHOWN
  const toggle = useCallback(() => {
    // Folding the grid back up: keep the row's heading in view.
    if (all) requestAnimationFrame(() => groupRef.current?.scrollIntoView({ block: 'nearest' }))
    setAll(!all)
  }, [all])
  const queue = fullQueue ?? shown.map((c) => c.track)
  return (
    <section className="home-section home-shelves-row" ref={groupRef} aria-label={title}>
      <div className="home-section-header">
        <h2 className="home-section-title">{title}</h2>
        {openAll ? (
          <button type="button" className="home-section-more" onClick={openAll}>See All</button>
        ) : more && (
          <button type="button" className="home-section-more" onClick={toggle} aria-expanded={all}>
            {all ? `Show Top ${SHELF_SHOWN}` : `See All ${Math.min(cards.length, SHELF_MAX)}`}
          </button>
        )}
      </div>
      <div className={`home-card-row${all ? ' home-card-row--shelf-grid' : ''}`} role="list" ref={rowRef}>
        {shown.map((c, i) => {
          const hash = artFor(c.track)
          const go = recentlyAddedPlay(queue, i)
          const play = () => { if (go) playTrack(go.queue[go.start]!, go.queue, go.start, undefined, true, true) }
          return (
            <div
              key={c.track.id}
              className="home-album-card home-album-card--shelf"
              role="listitem"
              tabIndex={0}
              onClick={play}
              onKeyDown={activateOnKey(play)}
              onContextMenu={(e) => menus?.openSongMenu(e, c.track, play, queue, i)}
              draggable
              onDragStart={(e) => setTrackDragPayload(e, c.track.id)}
              title={`${c.track.title} — ${c.track.artist}\nClick plays it, with the rest of this row after it.`}
            >
              <div className="home-album-art">
                {hash ? <AlbumArtImage hash={hash} alt={c.track.album || c.track.title} onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')} /> : <Placeholder />}
              </div>
              <div className="home-album-info">
                <div className="home-album-title">{c.track.title}</div>
                <div className="home-album-artist">{c.track.artist}</div>
                <div className={`home-shelves-note${c.count ? ' home-shelves-note--count' : ''}`}>{c.note}</div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function HomeShelves({ tracks, regularTracks, artworkMap, artIndex, dispatch, playTrack }: Props): JSX.Element | null {
  const { shelves } = useHomeShelves(tracks, regularTracks)
  // Listen More Weekly (2026-10-20): the row is the first songs of homemini's
  // weekly playlist, and "See All" opens it — when this Mac has a copy.
  const weekly = useListenMoreWeekly()

  const byId = useMemo(() => {
    const m = new Map<number, Track>()
    for (const t of regularTracks) m.set(t.id, t)
    return m
  }, [regularTracks])

  const artFor = useCallback((t: Track): string | undefined => {
    const key = albumKeyOf(t)
    if (artworkMap[key]) return artworkMap[key]
    return lookupArtwork(artworkMap, artIndex, t.albumArtist || t.artist || '', t.album || '')
  }, [artworkMap, artIndex])

  const gems = useMemo((): SongCard[] => (shelves?.listenMore ?? [])
    .map((g) => { const track = byId.get(g.id); return track ? { track, note: g.reason, count: false } : null })
    .filter((c): c is SongCard => c !== null), [shelves, byId])
  const heavy = useMemo((): SongCard[] => (shelves?.listeningALot ?? [])
    .map((h) => { const track = byId.get(h.id); return track ? { track, note: playsLabel(h.plays), count: true } : null })
    .filter((c): c is SongCard => c !== null), [shelves, byId])
  // Recently Added is SONGS (Jake, 2026-10-22): the newest 25 by date added;
  // the row draws 5 and a click queues all 25. Computed from the library, so
  // it is the same list whether or not homemini's document has arrived.
  // Phone twin: ios/JakeTunesMobile/HomeShelves.swift RecentlyAddedShelf.
  const recentSongs = useMemo((): Track[] => recentlyAddedSongs(
    regularTracks, { hidden: new Set<string>(), rankable: (t) => isTop25Rankable(t) },
  ), [regularTracks])
  const recent = useMemo((): SongCard[] => recentSongs.map((track) => ({
    track, note: addedLabel(Date.parse(track.dateAdded || '')), count: false,
  })), [recentSongs])

  // Covers the artwork map doesn't know yet: ask main to resolve them, and
  // warm the ones it does (the same two steps the old Recently Added row took).
  useEffect(() => {
    const firsts = [...gems.map((c) => c.track), ...heavy.map((c) => c.track), ...recent.slice(0, SHELF_SHOWN).map((c) => c.track)]
    const missing = firsts.filter((t) => !artFor(t)).map((t) => ({ artist: t.albumArtist || t.artist || '', album: t.album || '' }))
    if (missing.length) queueArtworkResolutions(missing, dispatch)
    prefetchAlbumArtHashes(firsts.map(artFor), 320)
  }, [gems, heavy, recent, artFor, dispatch])

  if (gems.length === 0 && heavy.length === 0 && recent.length === 0) return null
  return (
    <>
      {gems.length > 0 && (
        <SongRow title="You Should Listen To More" scrollKey="home-row-listen-more" cards={gems} artFor={artFor} playTrack={playTrack}
          openAll={weekly ? () => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: 'listen-more-weekly' }) : undefined} />
      )}
      {heavy.length > 0 && (
        <SongRow title="You’ve Been Listening To A Lot" scrollKey="home-row-listening-a-lot" cards={heavy} artFor={artFor} playTrack={playTrack} />
      )}
      {recent.length > 0 && (
        <SongRow title="Recently Added" scrollKey="home-row-recent" cards={recent} artFor={artFor} playTrack={playTrack}
          fullQueue={recentSongs} openAll={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: 'recently-added' })} />
      )}
    </>
  )
}
